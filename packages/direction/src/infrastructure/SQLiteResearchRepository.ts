import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import {
  isClosedResearchStatus,
  type IntentResearchSummary,
  type ResearchRequest,
  type ResearchRequestDetail,
  type ResearchResult,
  type ResearchSynthesis,
} from "../domain/Research.ts";
import type {
  CloseResearchRequestResult,
  CreateResearchRequestResult,
  RegisterResearchResultResult,
  RelatedResearchFindings,
  RegisterResearchSynthesisResult,
  ResearchRepository,
  ResearchRequestQuery,
} from "../domain/ResearchRepository.ts";
import type {
  CompleteResearchRequestInput,
  CreateResearchRequestInput,
  RegisterResearchResultInput,
  RegisterResearchSynthesisInput,
} from "../domain/ResearchRepository.ts";
import type {
  DirectionDatabase,
} from "./schema.ts";
import { inputHash } from "@compass/shared";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";
import { planResearchResultRecord, planResearchSynthesisRecord } from "./researchWriteRecord.ts";
import { intentResearchSummaryFromRecords } from "./researchSummaryRecord.ts";
import { loadResults, loadSyntheses, loadDetail, findRequestRow, researchSynthesesFromRecords } from "./researchReadRecord.ts";
import { insertResearchRequest, toRequest } from "./researchRequestRecord.ts";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";

type Executor = Kysely<DirectionDatabase> | Transaction<DirectionDatabase>;
const byRowid = sql`rowid`;

const findExistingIds = async (
  database: Executor,
  workspaceId: string,
  ids: readonly string[],
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const rows = await database
    .selectFrom("research_finding")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "in", [...ids])
    .execute();
  return new Set(rows.map((row) => row.id));
};

export class SQLiteResearchRepository implements ResearchRepository {
  /** `clock`は期限判定の時刻源。テストで固定できるよう注入する。 */
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly workspaces: DirectionWorkspaceReaders,
    private readonly clock: () => number = Date.now,
    private readonly changeObserver: DirectionChangeObserver | null = null,
  ) {}

  async createRequest(
    workspaceId: string,
    input: CreateResearchRequestInput,
  ): Promise<CreateResearchRequestResult> {
    return this.database
      .transaction()
      .execute(async (transaction): Promise<CreateResearchRequestResult> => {
        if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };

        const hash = inputHash(input);
        const existing = await transaction
          .selectFrom("research_request")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (existing) {
          return existing.input_hash === hash
            ? { kind: "replayed", request: toRequest(existing) }
            : { kind: "key_conflict", requestKey: input.requestKey };
        }

        // 再送の判定より後に置く。期限後に同じ入力を再送しても、作成済みのRequestを返せるようにする。
        const now = this.clock();
        if (input.deadlineAt !== null && input.deadlineAt <= now) {
          return { kind: "deadline_in_past", deadlineAt: input.deadlineAt };
        }

        if (input.originIntentId !== null) {
          const intent = await transaction
            .selectFrom("intent")
            .select("status")
            .where("id", "=", input.originIntentId)
            .where("workspace_id", "=", workspaceId)
            .executeTakeFirst();
          if (!intent) return { kind: "intent_not_found" };
          if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
          if (input.originOutcomeId !== null) {
            const outcome = await transaction
              .selectFrom("outcome")
              .select("id")
              .where("id", "=", input.originOutcomeId)
              .where("workspace_id", "=", workspaceId)
              .where("intent_id", "=", input.originIntentId)
              .executeTakeFirst();
            if (!outcome) return { kind: "outcome_not_found" };
          }
        }

        return {
          kind: "created",
          request: await insertResearchRequest(transaction, workspaceId, input, now, this.changeObserver),
        };
      });
  }

  async findRequests(workspaceId: string, query: ResearchRequestQuery = {}): Promise<ResearchRequest[]> {
    let statement = this.database.selectFrom("research_request").selectAll().where("workspace_id", "=", workspaceId);
    if (query.originIntentId !== undefined) statement = statement.where("origin_intent_id", "=", query.originIntentId);
    if (query.status !== undefined) statement = statement.where("status", "=", query.status);
    const rows = await statement.orderBy("created_at", "desc").orderBy(byRowid, "desc").execute();
    return rows.map(toRequest);
  }

  async findRequestDetail(workspaceId: string, requestId: string): Promise<ResearchRequestDetail | null> {
    const row = await findRequestRow(this.database, workspaceId, requestId);
    return row ? loadDetail(this.database, row) : null;
  }

  async findIntentResearchSummary(workspaceId: string, intentId: string): Promise<IntentResearchSummary> {
    const requestRows = await this.database
      .selectFrom("research_request")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("origin_intent_id", "=", intentId)
      .orderBy("created_at", "desc")
      .orderBy(byRowid, "desc")
      .execute();
    const requests = requestRows.map((row) => ({
      id: row.id,
      status: row.status,
      question: row.question,
      budgetTotal: row.budget_total,
      budgetUsed: row.budget_used,
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // cancelledのRequestは来歴として`requests`に残すが、圧縮結果（syntheses）の根拠からは外す。
    const openRequestIds = requestRows.filter((row) => row.status !== "cancelled").map((row) => row.id);
    if (openRequestIds.length === 0) return { requests, syntheses: [], conflicts: [] };

    const synthesisRows = await this.database
      .selectFrom("research_synthesis")
      .selectAll()
      .where("request_id", "in", openRequestIds)
      .orderBy("valid_as_of", "desc")
      .orderBy(byRowid, "desc")
      .execute();
    if (synthesisRows.length === 0) return { requests, syntheses: [], conflicts: [] };

    // このIntent配下のRequestに限定した系列内で、supersedesIdに指されていない行だけを最新versionとみなす。
    const supersededIds = new Set(
      synthesisRows.map((row) => row.supersedes_id).filter((id): id is string => id !== null),
    );
    const latestRows = synthesisRows.filter((row) => !supersededIds.has(row.id));

    const links = await this.database
      .selectFrom("research_synthesis_finding")
      .selectAll()
      .where(
        "synthesis_id",
        "in",
        latestRows.map((row) => row.id),
      )
      .orderBy("position", "asc")
      .execute();
    const findingIds = [...new Set(links.map((link) => link.finding_id))];
    const findingRows =
      findingIds.length === 0
        ? []
        : await this.database
            .selectFrom("research_finding")
            .select(["id", "expires_at"])
            .where("id", "in", findingIds)
            .execute();
    const now = this.clock();

    // research_finding_conflictは宣言方向が非対称（新Findingが既存Findingを指す）なので、
    // findingIdsが宣言元・宣言先いずれの当事者になっている行も両方拾う。
    const conflictRows =
      findingIds.length === 0
        ? []
        : await this.database
            .selectFrom("research_finding_conflict")
            .selectAll()
            .where((eb) =>
              eb.or([eb("finding_id", "in", findingIds), eb("conflicting_finding_id", "in", findingIds)]),
            )
            .execute();
    return intentResearchSummaryFromRecords(requestRows.map(toRequest), researchSynthesesFromRecords(synthesisRows, links), findingRows, conflictRows, now);
  }

  async findRelatedFindings(workspaceId: string, requestId: string, limit: number): Promise<RelatedResearchFindings> {
    const request = await findRequestRow(this.database, workspaceId, requestId);
    if (!request) return { findings: [], evidenceRefs: [] };
    let statement = this.database
      .selectFrom("research_finding")
      .innerJoin("research_request", "research_request.id", "research_finding.request_id")
      .select(["research_finding.id as id", "research_finding.result_id as result_id"])
      .where("research_finding.workspace_id", "=", workspaceId)
      .where("research_finding.request_id", "!=", requestId)
      .where("research_request.kind", "=", request.kind);
    statement =
      request.origin_intent_id === null
        ? statement.where("research_request.origin_intent_id", "is", null)
        : statement.where("research_request.origin_intent_id", "=", request.origin_intent_id);
    const selected = await statement
      .orderBy("research_finding.created_at", "desc")
      .orderBy(sql`research_finding.rowid`, "desc")
      .limit(limit)
      .execute();
    if (selected.length === 0) return { findings: [], evidenceRefs: [] };

    const resultRows = await this.database
      .selectFrom("research_result")
      .selectAll()
      .where("id", "in", [...new Set(selected.map((row) => row.result_id))])
      .execute();
    const results = await loadResults(this.database, resultRows);
    const wanted = new Set(selected.map((row) => row.id));
    const findingsById = new Map(
      results.flatMap((result) => result.findings).filter((finding) => wanted.has(finding.id)).map((finding) => [finding.id, finding]),
    );
    const findings = selected.map((row) => findingsById.get(row.id)!);
    const cited = new Set(findings.flatMap((finding) => finding.evidenceRefIds));
    const evidenceRefs = results.flatMap((result) => result.evidenceRefs).filter((evidence) => cited.has(evidence.id));
    return { findings, evidenceRefs };
  }

  async registerResult(
    workspaceId: string,
    requestId: string,
    input: RegisterResearchResultInput,
  ): Promise<RegisterResearchResultResult> {
    return this.database
      .transaction()
      .execute(async (transaction): Promise<RegisterResearchResultResult> => {
        if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
        const request = await findRequestRow(transaction, workspaceId, requestId);
        if (!request) return { kind: "request_not_found" };

        const hash = inputHash(input);
        const existing = await transaction
          .selectFrom("research_result")
          .selectAll()
          .where("request_id", "=", requestId)
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
          const [result] = await loadResults(transaction, [existing]);
          return { kind: "replayed", result: result! };
        }

        if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
        const now = this.clock();
        if (request.deadline_at !== null && now > request.deadline_at) {
          return { kind: "deadline_passed", deadlineAt: request.deadline_at };
        }
        const budgetUsed = request.budget_used + input.budgetUsed;
        if (budgetUsed > request.budget_total) {
          return { kind: "budget_exceeded", budgetTotal: request.budget_total, budgetUsed };
        }

        const resourceIds = [...new Set(input.evidenceRefs.flatMap(ref => ref.resourceId ? [ref.resourceId] : []))];
        const missingResources: string[] = [];
        for (const resourceId of resourceIds) {
          if (!await this.workspaces(transaction).resourceBelongsToWorkspace(workspaceId, resourceId)) missingResources.push(resourceId);
        }
        if (missingResources.length > 0) return { kind: "invalid_reference", reference: "resource", ids: missingResources };

        const conflictIds = [...new Set(input.findings.flatMap((finding) => finding.conflictsWithFindingIds))];
        const known = await findExistingIds(transaction, workspaceId, conflictIds);
        const missing = conflictIds.filter((id) => !known.has(id));
        if (missing.length > 0) return { kind: "invalid_reference", reference: "finding", ids: missing };

        const last = await transaction
          .selectFrom("research_result")
          .select((builder) => builder.fn.max<number>("sequence").as("sequence"))
          .where("request_id", "=", requestId)
          .executeTakeFirst();
        const plan = planResearchResultRecord(transaction, workspaceId, requestId, input, (last?.sequence ?? 0) + 1, now);
        for (const query of plan.mutations) await transaction.executeQuery(query);
        const resultRow = plan.row;

        await transaction
          .updateTable("research_request")
          .set({ status: "running", budget_used: budgetUsed, updated_at: now })
          .where("id", "=", requestId)
          .execute();
        const [result] = await loadResults(transaction, [resultRow]);
        return { kind: "registered", result: result! };
      });
  }

  async registerSynthesis(
    workspaceId: string,
    requestId: string,
    input: RegisterResearchSynthesisInput,
  ): Promise<RegisterResearchSynthesisResult> {
    return this.database
      .transaction()
      .execute(async (transaction): Promise<RegisterResearchSynthesisResult> => {
        if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
        const request = await findRequestRow(transaction, workspaceId, requestId);
        if (!request) return { kind: "request_not_found" };

        const hash = inputHash(input);
        const existing = await transaction
          .selectFrom("research_synthesis")
          .selectAll()
          .where("request_id", "=", requestId)
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
          const [synthesis] = await loadSyntheses(transaction, [existing]);
          return { kind: "replayed", synthesis: synthesis! };
        }

        if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
        const now = this.clock();
        if (request.deadline_at !== null && now > request.deadline_at) {
          return { kind: "deadline_passed", deadlineAt: request.deadline_at };
        }

        const known = await findExistingIds(transaction, workspaceId, input.findingIds);
        const missing = input.findingIds.filter((id) => !known.has(id));
        if (missing.length > 0) return { kind: "invalid_reference", reference: "finding", ids: missing };

        let version = 1;
        if (input.supersedesId !== null) {
          const previous = await transaction
            .selectFrom("research_synthesis")
            .select("version")
            .where("id", "=", input.supersedesId)
            .where("workspace_id", "=", workspaceId)
            .executeTakeFirst();
          if (!previous) return { kind: "invalid_reference", reference: "supersedes", ids: [input.supersedesId] };
          const successor = await transaction
            .selectFrom("research_synthesis")
            .select("id")
            .where("supersedes_id", "=", input.supersedesId)
            .executeTakeFirst();
          if (successor) {
            return { kind: "already_superseded", supersedesId: input.supersedesId, supersededById: successor.id };
          }
          version = previous.version + 1;
        }

        const plan = planResearchSynthesisRecord(transaction, workspaceId, requestId, input, version, now);
        for (const query of plan.mutations) await transaction.executeQuery(query);
        const row = plan.row;
        if (request.status === "requested") {
          await transaction
            .updateTable("research_request")
            .set({ status: "running", updated_at: now })
            .where("id", "=", requestId)
            .execute();
        }
        const [synthesis] = await loadSyntheses(transaction, [row]);
        return { kind: "registered", synthesis: synthesis! };
      });
  }

  async complete(
    workspaceId: string,
    requestId: string,
    input: CompleteResearchRequestInput,
  ): Promise<CloseResearchRequestResult> {
    return this.close(workspaceId, requestId, input.conclusion, input.stopReason, async (transaction) => {
      if (input.conclusion !== "completed") return null;
      for (const [table, missing] of [
        ["research_result", "result"],
        ["research_synthesis", "synthesis"],
      ] as const) {
        const found = await transaction
          .selectFrom(table)
          .select("id")
          .where("request_id", "=", requestId)
          .executeTakeFirst();
        if (!found) return missing;
      }
      return null;
    });
  }

  async cancel(workspaceId: string, requestId: string, reason: string): Promise<CloseResearchRequestResult> {
    return this.close(workspaceId, requestId, "cancelled", reason, async () => null);
  }

  /** 未終了のRequestだけを、状態確認と同一transactionで終了状態へ進める。 */
  private async close(
    workspaceId: string,
    requestId: string,
    status: "completed" | "insufficient" | "not_needed" | "cancelled",
    stopReason: string | null,
    findMissing: (transaction: Transaction<DirectionDatabase>) => Promise<"result" | "synthesis" | null>,
  ): Promise<CloseResearchRequestResult> {
    return this.database.transaction().execute(async (transaction): Promise<CloseResearchRequestResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const request = await findRequestRow(transaction, workspaceId, requestId);
      if (!request) return { kind: "request_not_found" };
      if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
      const missing = await findMissing(transaction);
      if (missing) return { kind: "incomplete", missing };

      const now = this.clock();
      const row = await transaction
        .updateTable("research_request")
        .set({ status, stop_reason: stopReason, updated_at: now })
        .where("id", "=", requestId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await notifyDirectionChange(this.changeObserver, transaction, {
        type: "research_closed",
        workspaceId,
        recordId: row.id,
        title: row.question,
        refs: [
          { kind: "research_request", id: row.id },
          ...(row.origin_intent_id ? [{ kind: "intent" as const, id: row.origin_intent_id }] : []),
        ],
        result: status,
        reason: stopReason,
        principalId: null,
        occurredAt: now,
      });
      return { kind: "closed", request: toRequest(row) };
    });
  }
}
