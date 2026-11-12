import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import { ConflictError, inputHash } from "@compass/shared";
import { planDirectionDecisionRecord, validateResearchReferences, validateEvaluationReference, planOutcomeCreationRecord,
  insertOutcomeConfirmedEventQuery, researchRequestRow, researchRequestFromRow, insertRuntimeEventQuery,
  additionalResearchRequestKey, additionalResearchCorrelationId, type DirectionDatabase, type DirectionDecisionRepository,
  type DirectionDecision, type CreateDirectionDecisionInput, type DecideNextOutcomeInput,
  type CreateDirectionDecisionResult, type DecideNextOutcomeResult, type IntentResearchSummary } from "@compass/direction";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import type { D1DirectionActivityPlanner } from "./planD1DirectionActivity.ts";
import { readD1Decisions } from "./readD1Decisions.ts";
import { d1OutcomeSnapshotQueries, outcomesFromD1Results, readD1Outcomes } from "./readD1Outcomes.ts";

type DecisionInput = (CreateDirectionDecisionInput | DecideNextOutcomeInput) & { principalId: string };

export class D1DirectionDecisionRepository implements DirectionDecisionRepository {
  private readonly atomic: D1AtomicBatch;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database,
    private readonly activity: D1DirectionActivityPlanner, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async create(workspaceId: string, brief: IntentResearchSummary, input: CreateDirectionDecisionInput & { principalId: string }): Promise<CreateDirectionDecisionResult> {
    const hash = inputHash(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writable(workspaceId).executeTakeFirst()) return { kind: "workspace_archived", workspaceId };
      const sameKey = this.decisions(workspaceId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        const decision = (await readD1Decisions(this.database, this.binding, sameKey))[0]!;
        const request = await this.database.selectFrom("research_request").selectAll().where("workspace_id", "=", workspaceId)
          .where("request_key", "=", additionalResearchRequestKey(existing.id)).executeTakeFirst();
        return { kind: "replayed", decision, researchRequest: request ? researchRequestFromRow(request) : null };
      }
      const now = this.clock();
      if (input.research && input.research.deadlineAt !== null && input.research.deadlineAt <= now) return { kind: "deadline_in_past", deadlineAt: input.research.deadlineAt };
      const check = await this.validate(workspaceId, input, input.type);
      if (check.kind !== "ready") return check;
      const plan = planDirectionDecisionRecord(this.database, workspaceId, crypto.randomUUID(), input.type, null, brief, input, hash, now);
      const mutations = [...plan.mutations, ...this.recorded(plan.decision)];
      if (input.type === "intent_complete") mutations.push(this.database.updateTable("intent").set({ status: "achieved", updated_at: now }).where("id", "=", input.intentId).compile());
      const request = input.research ? researchRequestRow(workspaceId, { ...input.research, requestKey: additionalResearchRequestKey(plan.row.id),
        kind: "decision", originIntentId: input.intentId, originOutcomeId: null, correlationId: additionalResearchCorrelationId(plan.row.id) }, now) : null;
      if (request) mutations.push(this.database.insertInto("research_request").values(request).compile(),
        ...this.activity({ type: "research_requested", workspaceId, recordId: request.id, title: request.question,
          refs: [{ kind: "research_request", id: request.id }, { kind: "intent", id: input.intentId }], result: null, reason: null, principalId: null, occurredAt: now }),
        insertRuntimeEventQuery(this.database, { type: "research_requested", workspaceId, intentId: input.intentId, researchRequestId: request.id,
          correlationId: request.correlation_id, conclusion: null, occurredAt: now }).compile());
      try {
        await this.atomic.execute([this.writable(workspaceId).compile(), sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database), ...check.guards], mutations);
        return { kind: "created", decision: plan.decision, researchRequest: request ? researchRequestFromRow(request) : null };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Direction Decision changed repeatedly during creation", { workspaceId, requestKey: input.requestKey });
  }

  async decideNextOutcome(workspaceId: string, brief: IntentResearchSummary, input: DecideNextOutcomeInput & { principalId: string }): Promise<DecideNextOutcomeResult> {
    const hash = inputHash(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writable(workspaceId).executeTakeFirst()) return { kind: "workspace_archived", workspaceId };
      const sameKey = this.decisions(workspaceId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        const decision = (await readD1Decisions(this.database, this.binding, sameKey))[0]!;
        const outcome = (await readD1Outcomes(this.database, this.binding, this.database.selectFrom("outcome").selectAll().where("id", "=", existing.outcome_id!)))[0]!;
        return { kind: "replayed", decision, outcome };
      }
      const check = await this.validate(workspaceId, input, "next_outcome");
      if (check.kind !== "ready") return check;
      const now = this.clock(), outcomeId = crypto.randomUUID(), decisionId = crypto.randomUUID();
      const outcome = await planOutcomeCreationRecord(this.database, workspaceId, input.intentId, outcomeId, decisionId,
        { ...input.outcome, intentVersion: input.intentVersion }, now);
      const decision = planDirectionDecisionRecord(this.database, workspaceId, decisionId, "next_outcome", outcomeId, brief, input, hash, now);
      try {
        const results = await this.atomic.execute([this.writable(workspaceId).compile(), sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database),
          ...check.guards, ...outcome.preconditions], [...outcome.mutations, ...this.activity(outcome.notice),
          insertOutcomeConfirmedEventQuery(this.database, { workspaceId, intentId: input.intentId, outcomeId, occurredAt: now }).compile(),
          ...decision.mutations, ...this.recorded(decision.decision),
          ...d1OutcomeSnapshotQueries(this.database, this.database.selectFrom("outcome").selectAll().where("id", "=", outcomeId))]);
        return { kind: "created", decision: decision.decision, outcome: outcomesFromD1Results(results.slice(-4))[0]! };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Direction Decision changed repeatedly during Outcome creation", { workspaceId, requestKey: input.requestKey });
  }

  findByIntent(workspaceId: string, intentId: string) {
    return readD1Decisions(this.database, this.binding, this.decisions(workspaceId).where("intent_id", "=", intentId).orderBy("created_at", "desc").orderBy(sql`rowid`, "desc"));
  }

  private async validate(workspaceId: string, input: DecisionInput, type: DirectionDecision["type"]) {
    const intentQuery = this.database.selectFrom("intent").select(["id", "status", "version", "completion_definition"]).where("workspace_id", "=", workspaceId).where("id", "=", input.intentId);
    const intent = await intentQuery.executeTakeFirst();
    if (!intent) return { kind: "intent_not_found" as const };
    if (intent.status !== "active") return { kind: "intent_not_active" as const, status: intent.status };
    if (intent.version !== input.intentVersion) return { kind: "intent_version_conflict" as const, currentVersion: intent.version };
    if (type === "intent_complete" && intent.completion_definition === null) return { kind: "no_completion_definition" as const };
    const references = await validateResearchReferences(this.database, workspaceId, input.usedSyntheses, input.usedFindingIds);
    if (references.kind !== "ok") return references;
    const guards = [intentQuery.where("status", "=", "active").where("version", "=", intent.version).compile(),
      ...input.usedSyntheses.map((ref) => this.database.selectFrom("research_synthesis").select("id").where("workspace_id", "=", workspaceId)
        .where("id", "=", ref.synthesisId).where("version", "=", ref.version).compile()),
      ...input.usedFindingIds.map((id) => this.database.selectFrom("research_finding").select("id").where("workspace_id", "=", workspaceId).where("id", "=", id).compile())];
    if (input.evaluationId !== undefined) {
      const evaluation = await validateEvaluationReference(this.database, workspaceId, input.intentId, input.evaluationId, type);
      if (evaluation.kind !== "ok") return evaluation;
      const row = await this.database.selectFrom("outcome_evaluation").select("outcome_id").where("id", "=", input.evaluationId).executeTakeFirstOrThrow();
      const linked = this.database.selectFrom("outcome_evaluation").innerJoin("outcome", "outcome.id", "outcome_evaluation.outcome_id")
        .select("outcome_evaluation.id").where("outcome_evaluation.id", "=", input.evaluationId).where("outcome_evaluation.intent_id", "=", input.intentId)
        .where("outcome.workspace_id", "=", workspaceId).where("outcome.status", "!=", "cancelled");
      const decided = this.database.selectFrom("direction_decision").select("id").where("evaluation_id", "=", input.evaluationId);
      guards.push(linked.compile(), sql`SELECT 1 WHERE NOT EXISTS ${decided}`.compile(this.database),
        sql`SELECT 1 WHERE (SELECT id FROM outcome_evaluation WHERE outcome_id = ${row.outcome_id} ORDER BY created_at DESC, rowid DESC LIMIT 1) = ${input.evaluationId}`.compile(this.database));
    }
    return { kind: "ready" as const, guards };
  }
  private decisions(workspaceId: string) { return this.database.selectFrom("direction_decision").selectAll().where("workspace_id", "=", workspaceId); }
  private writable(workspaceId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
  private recorded(decision: DirectionDecision) {
    return this.activity({ type: "decision_recorded", workspaceId: decision.workspaceId, recordId: decision.id, title: decision.judgment,
      refs: [{ kind: "decision", id: decision.id }, { kind: "intent", id: decision.intentId }, ...(decision.outcomeId ? [{ kind: "outcome" as const, id: decision.outcomeId }] : [])],
      result: decision.type, reason: decision.reason, principalId: decision.principalId, occurredAt: decision.createdAt });
  }
}
