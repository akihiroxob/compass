import type { D1Database } from "@cloudflare/workers-types";
import { sql, type CompiledQuery, type Kysely, type Selectable } from "kysely";
import { ConflictError, inputHash } from "@compass/shared";
import { isClosedResearchStatus, researchRequestRow, researchRequestFromRow, planResearchResultRecord, planResearchSynthesisRecord,
  insertRuntimeEventQuery, intentResearchSummaryFromRecords, type ResearchRepository, type DirectionDatabase, type ResearchRequestTable,
  type CreateResearchRequestInput, type CreateResearchRequestResult, type RegisterResearchResultInput, type RegisterResearchResultResult,
  type RegisterResearchSynthesisInput, type RegisterResearchSynthesisResult, type CompleteResearchRequestInput,
  type CloseResearchRequestResult, type ResearchRequestQuery } from "@compass/direction";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import type { D1DirectionActivityPlanner } from "./planD1DirectionActivity.ts";
import { readD1Research } from "./readD1Research.ts";

export class D1ResearchRepository implements ResearchRepository {
  private readonly atomic: D1AtomicBatch;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database,
    private readonly activity: D1DirectionActivityPlanner, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async createRequest(workspaceId: string, input: CreateResearchRequestInput): Promise<CreateResearchRequestResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writable(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const sameKey = this.requests(workspaceId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) return existing.input_hash === inputHash(input) ? { kind: "replayed", request: researchRequestFromRow(existing) } : { kind: "key_conflict", requestKey: input.requestKey };
      const now = this.clock();
      if (input.deadlineAt !== null && input.deadlineAt <= now) return { kind: "deadline_in_past", deadlineAt: input.deadlineAt };
      const guards = [this.writable(workspaceId).compile(), sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database)];
      if (input.originIntentId !== null) {
        const intentQuery = this.database.selectFrom("intent").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", input.originIntentId);
        const intent = await intentQuery.executeTakeFirst();
        if (!intent) return { kind: "intent_not_found" };
        if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
        guards.push(intentQuery.where("status", "=", "active").compile());
        if (input.originOutcomeId !== null) {
          const outcome = this.database.selectFrom("outcome").select("id").where("workspace_id", "=", workspaceId).where("intent_id", "=", input.originIntentId).where("id", "=", input.originOutcomeId);
          if (!await outcome.executeTakeFirst()) return { kind: "outcome_not_found" };
          guards.push(outcome.compile());
        }
      }
      const row = researchRequestRow(workspaceId, input, now);
      try {
        await this.atomic.execute(guards, [this.database.insertInto("research_request").values(row).compile(), ...this.notice(row, "research_requested"),
          this.event(row, "research_requested")]);
        return { kind: "created", request: researchRequestFromRow(row) };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Research request changed repeatedly during creation", { workspaceId, requestKey: input.requestKey });
  }

  async findRequests(workspaceId: string, input: ResearchRequestQuery = {}) {
    let query = this.requests(workspaceId);
    if (input.originIntentId !== undefined) query = query.where("origin_intent_id", "=", input.originIntentId);
    if (input.status !== undefined) query = query.where("status", "=", input.status);
    return (await query.orderBy("created_at", "desc").orderBy(sql`rowid`, "desc").execute()).map(researchRequestFromRow);
  }
  async findRequestDetail(workspaceId: string, requestId: string) {
    const graph = await readD1Research(this.database, this.binding, this.requests(workspaceId).where("id", "=", requestId));
    return graph.requests[0] ? { request: graph.requests[0], results: graph.results, syntheses: graph.syntheses } : null;
  }
  async findIntentResearchSummary(workspaceId: string, intentId: string) {
    const graph = await readD1Research(this.database, this.binding, this.requests(workspaceId).where("origin_intent_id", "=", intentId)
      .orderBy("created_at", "desc").orderBy(sql`rowid`, "desc"),
      this.database.selectFrom("research_result").selectAll().where(sql<boolean>`0`), true);
    return intentResearchSummaryFromRecords(graph.requests, graph.syntheses, graph.findingRows, graph.conflictRows, this.clock());
  }
  async findRelatedFindings(workspaceId: string, requestId: string, limit: number) {
    const request = await this.request(workspaceId, requestId).executeTakeFirst();
    if (!request) return { findings: [], evidenceRefs: [] };
    let query = this.database.selectFrom("research_finding as f").innerJoin("research_request as r", "r.id", "f.request_id")
      .select(["f.id", "f.result_id"]).where("f.workspace_id", "=", workspaceId).where("f.request_id", "!=", requestId).where("r.kind", "=", request.kind);
    query = request.origin_intent_id === null ? query.where("r.origin_intent_id", "is", null) : query.where("r.origin_intent_id", "=", request.origin_intent_id);
    const selected = await query.orderBy("f.created_at", "desc").orderBy(sql`f.rowid`, "desc").limit(limit).execute();
    if (!selected.length) return { findings: [], evidenceRefs: [] };
    const resultIds = JSON.stringify([...new Set(selected.map((row) => row.result_id))]);
    const graph = await readD1Research(this.database, this.binding, this.request(workspaceId, requestId),
      this.database.selectFrom("research_result").selectAll().where(sql<boolean>`id IN (SELECT value FROM json_each(${resultIds}))`));
    const all = new Map(graph.results.flatMap(({ findings }) => findings).map((finding) => [finding.id, finding]));
    const findings = selected.map(({ id }) => all.get(id)!);
    const cited = new Set(findings.flatMap(({ evidenceRefIds }) => evidenceRefIds));
    return { findings, evidenceRefs: graph.results.flatMap(({ evidenceRefs }) => evidenceRefs).filter(({ id }) => cited.has(id)) };
  }

  async registerResult(workspaceId: string, requestId: string, input: RegisterResearchResultInput): Promise<RegisterResearchResultResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writable(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const request = await this.request(workspaceId, requestId).executeTakeFirst();
      if (!request) return { kind: "request_not_found" };
      const sameKey = this.database.selectFrom("research_result").selectAll().where("request_id", "=", requestId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== inputHash(input)) return { kind: "key_conflict", requestKey: input.requestKey };
        const graph = await readD1Research(this.database, this.binding, this.request(workspaceId, requestId), sameKey);
        return { kind: "replayed", result: graph.results[0]! };
      }
      if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
      const now = this.clock();
      if (request.deadline_at !== null && now > request.deadline_at) return { kind: "deadline_passed", deadlineAt: request.deadline_at };
      const budgetUsed = request.budget_used + input.budgetUsed;
      if (budgetUsed > request.budget_total) return { kind: "budget_exceeded", budgetTotal: request.budget_total, budgetUsed };
      const guards = [this.writable(workspaceId).compile(), this.request(workspaceId, requestId).where("status", "=", request.status).where("budget_used", "=", request.budget_used).compile(),
        sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database)];
      const organization = asOrganizationDatabase(this.database);
      const missingResources: string[] = [];
      for (const id of new Set(input.evidenceRefs.flatMap((ref) => ref.resourceId ? [ref.resourceId] : []))) {
        const resource = organization.selectFrom("project_resource").innerJoin("project", "project.id", "project_resource.project_id")
          .select("project_resource.id").where("project_resource.id", "=", id).where("project.workspace_id", "=", workspaceId);
        if (!await resource.executeTakeFirst()) missingResources.push(id);
        guards.push(resource.compile());
      }
      if (missingResources.length) return { kind: "invalid_reference", reference: "resource", ids: missingResources };
      const refs = await this.findingGuards(workspaceId, [...new Set(input.findings.flatMap(({ conflictsWithFindingIds }) => conflictsWithFindingIds))]);
      if (refs.missing.length) return { kind: "invalid_reference", reference: "finding", ids: refs.missing };
      guards.push(...refs.guards);
      const sequence = (await this.database.selectFrom("research_result").select((eb) => eb.fn.max<number>("sequence").as("last")).where("request_id", "=", requestId).executeTakeFirst())?.last ?? 0;
      guards.push(sql`SELECT 1 WHERE COALESCE((SELECT MAX(sequence) FROM research_result WHERE request_id = ${requestId}), 0) = ${sequence}`.compile(this.database));
      const plan = planResearchResultRecord(this.database, workspaceId, requestId, input, sequence + 1, now);
      try {
        await this.atomic.execute(guards, [...plan.mutations, this.database.updateTable("research_request").set({ status: "running", budget_used: budgetUsed, updated_at: now }).where("id", "=", requestId).compile()]);
        return { kind: "registered", result: plan.result };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Research result changed repeatedly during registration", { requestId });
  }

  async registerSynthesis(workspaceId: string, requestId: string, input: RegisterResearchSynthesisInput): Promise<RegisterResearchSynthesisResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writable(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const request = await this.request(workspaceId, requestId).executeTakeFirst();
      if (!request) return { kind: "request_not_found" };
      const sameKey = this.database.selectFrom("research_synthesis").selectAll().where("request_id", "=", requestId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== inputHash(input)) return { kind: "key_conflict", requestKey: input.requestKey };
        const graph = await readD1Research(this.database, this.binding, this.request(workspaceId, requestId));
        return { kind: "replayed", synthesis: graph.syntheses.find(({ id }) => id === existing.id)! };
      }
      if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
      const now = this.clock();
      if (request.deadline_at !== null && now > request.deadline_at) return { kind: "deadline_passed", deadlineAt: request.deadline_at };
      const refs = await this.findingGuards(workspaceId, input.findingIds);
      if (refs.missing.length) return { kind: "invalid_reference", reference: "finding", ids: refs.missing };
      const guards = [this.writable(workspaceId).compile(), this.request(workspaceId, requestId).where("status", "=", request.status).compile(),
        sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database), ...refs.guards];
      let version = 1;
      if (input.supersedesId !== null) {
        const previous = this.database.selectFrom("research_synthesis").select(["id", "version"]).where("workspace_id", "=", workspaceId).where("id", "=", input.supersedesId);
        const row = await previous.executeTakeFirst();
        if (!row) return { kind: "invalid_reference", reference: "supersedes", ids: [input.supersedesId] };
        const newer = this.database.selectFrom("research_synthesis").select("id").where("supersedes_id", "=", input.supersedesId);
        const successor = await newer.executeTakeFirst();
        if (successor) return { kind: "already_superseded", supersedesId: input.supersedesId, supersededById: successor.id };
        guards.push(previous.compile(), sql`SELECT 1 WHERE NOT EXISTS ${newer}`.compile(this.database));
        version = row.version + 1;
      }
      const plan = planResearchSynthesisRecord(this.database, workspaceId, requestId, input, version, now);
      try {
        await this.atomic.execute(guards, [...plan.mutations, ...(request.status === "requested" ? [this.database.updateTable("research_request").set({ status: "running", updated_at: now }).where("id", "=", requestId).compile()] : [])]);
        return { kind: "registered", synthesis: plan.synthesis };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Research synthesis changed repeatedly during registration", { requestId });
  }

  complete(workspaceId: string, requestId: string, input: CompleteResearchRequestInput) { return this.close(workspaceId, requestId, input.conclusion, input.stopReason); }
  cancel(workspaceId: string, requestId: string, reason: string) { return this.close(workspaceId, requestId, "cancelled", reason); }
  private async close(workspaceId: string, requestId: string, status: "completed" | "insufficient" | "not_needed" | "cancelled", reason: string | null): Promise<CloseResearchRequestResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writable(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const request = await this.request(workspaceId, requestId).executeTakeFirst();
      if (!request) return { kind: "request_not_found" };
      if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
      const guards = [this.writable(workspaceId).compile(), this.request(workspaceId, requestId).where("status", "=", request.status).where("budget_used", "=", request.budget_used).compile()];
      if (status === "completed") {
        for (const [table, missing] of [["research_result", "result"], ["research_synthesis", "synthesis"]] as const) {
          const query = this.database.selectFrom(table).select("id").where("request_id", "=", requestId);
          if (!await query.executeTakeFirst()) return { kind: "incomplete", missing };
          guards.push(query.compile());
        }
      }
      const events: CompiledQuery[] = [];
      const row = { ...request, status, stop_reason: reason, updated_at: this.clock() };
      if (status !== "cancelled" && request.origin_intent_id !== null) {
        const intentQuery = this.database.selectFrom("intent").select(["id", "status"]).where("id", "=", request.origin_intent_id);
        const intent = await intentQuery.executeTakeFirst();
        if (intent) guards.push(intentQuery.where("status", "=", intent.status).compile());
        if (intent?.status === "active") events.push(this.event(row, "research_completed"));
      }
      try {
        await this.atomic.execute(guards, [this.database.updateTable("research_request").set({ status, stop_reason: reason, updated_at: row.updated_at }).where("id", "=", requestId).compile(),
          ...this.notice(row, "research_closed"), ...events]);
        return { kind: "closed", request: researchRequestFromRow(row) };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Research request changed repeatedly during closure", { requestId });
  }

  private requests(workspaceId: string) { return this.database.selectFrom("research_request").selectAll().where("workspace_id", "=", workspaceId); }
  private request(workspaceId: string, requestId: string) { return this.requests(workspaceId).where("id", "=", requestId); }
  private writable(workspaceId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
  private async findingGuards(workspaceId: string, ids: string[]) {
    const guards: CompiledQuery[] = [], missing: string[] = [];
    for (const id of ids) {
      const query = this.database.selectFrom("research_finding").select("id").where("id", "=", id).where("workspace_id", "=", workspaceId);
      if (!await query.executeTakeFirst()) missing.push(id);
      guards.push(query.compile());
    }
    return { guards, missing };
  }
  private notice(row: Selectable<ResearchRequestTable>, type: "research_requested" | "research_closed") {
    return this.activity({ type, workspaceId: row.workspace_id, recordId: row.id, title: row.question,
      refs: [{ kind: "research_request", id: row.id }, ...(row.origin_intent_id ? [{ kind: "intent" as const, id: row.origin_intent_id }] : []),
        ...(type === "research_requested" && row.origin_outcome_id ? [{ kind: "outcome" as const, id: row.origin_outcome_id }] : [])],
      result: type === "research_closed" ? row.status : null, reason: type === "research_closed" ? row.stop_reason : null, principalId: null, occurredAt: row.updated_at });
  }
  private event(row: Selectable<ResearchRequestTable>, type: "research_requested" | "research_completed") {
    return insertRuntimeEventQuery(this.database, { type, workspaceId: row.workspace_id, intentId: row.origin_intent_id, researchRequestId: row.id,
      correlationId: row.correlation_id, conclusion: type === "research_requested" ? null : row.status as "completed" | "insufficient" | "not_needed", occurredAt: row.updated_at }).compile();
  }
}
