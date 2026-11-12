import { sql } from "kysely";
import type { Kysely } from "kysely";
import { inputHash } from "@compass/shared";
import type {
  IntentExplanation,
  IntentExplanationBasisReference,
  IntentExplanationBasisState,
  IntentExplanationView,
  ResolvedIntentExplanationBasis,
} from "../domain/IntentExplanation.ts";
import type {
  IntentExplanationRepository,
  RecordIntentExplanationInput,
  RecordIntentExplanationResult,
} from "../domain/IntentExplanationRepository.ts";
import type { DirectionDatabase } from "./schema.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";

import { loadIntentExplanations, explanationReferenceQueries, planIntentExplanationRecord } from "./intentExplanationRecord.ts";

/** 一覧で返す説明の上限（新しい順）。 */
const listLimit = 50;

const idsSubquery = (ids: readonly string[]) => sql<string>`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
const unique = (values: string[]): string[] => [...new Set(values)];

export class SQLiteIntentExplanationRepository implements IntentExplanationRepository {
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly workspaces: DirectionWorkspaceReaders,
  ) {}

  async record(
    workspaceId: string,
    intentId: string,
    principalId: string,
    input: RecordIntentExplanationInput,
    at: number,
  ): Promise<RecordIntentExplanationResult> {
    return this.database.transaction().execute(async (transaction): Promise<RecordIntentExplanationResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const hash = inputHash({ intentId, ...input });
      const existing = await transaction
        .selectFrom("intent_explanation")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("request_key", "=", input.requestKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        const [explanation] = await loadIntentExplanations(transaction, [existing]);
        return { kind: "replayed", explanation: explanation! };
      }
      const intent = await transaction
        .selectFrom("intent")
        .select("status")
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
      const metric = await transaction
        .selectFrom("intent_metric")
        .select("id")
        .where("intent_id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .where("key", "=", input.metricKey)
        .executeTakeFirst();
      if (!metric) return { kind: "metric_not_found" };

      const references: { path: string; id: string; message: string }[] = [];
      for (const reference of explanationReferenceQueries(transaction, workspaceId, intentId, metric.id, input)) {
        if (!(await transaction.executeQuery(reference.query)).rows.length) references.push({ path: reference.path, id: reference.id, message: reference.message });
      }
      if (references.length > 0) return { kind: "invalid_reference", references };

      const previous = await transaction
        .selectFrom("intent_explanation")
        .select(["id", "version"])
        .where("intent_id", "=", intentId)
        .where("metric_key", "=", input.metricKey)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
      const plan = planIntentExplanationRecord(transaction, workspaceId, intentId, principalId, input, at, previous);
      for (const query of plan.mutations) await transaction.executeQuery(query);
      return { kind: "recorded", explanation: plan.explanation };
    });
  }

  async listByIntent(workspaceId: string, intentId: string, at: number): Promise<IntentExplanationView[] | null> {
    const intent = await this.database.selectFrom("intent").select("id").where("id", "=", intentId).where("workspace_id", "=", workspaceId).executeTakeFirst();
    if (!intent) return null;
    const rows = await this.database
      .selectFrom("intent_explanation")
      .selectAll()
      .where("intent_id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy("version", "desc")
      .limit(listLimit)
      .execute();
    const explanations = await loadIntentExplanations(this.database, rows);
    const bases = explanations.flatMap((explanation) => explanation.items.flatMap((item) => item.basis));
    const idsOf = (type: IntentExplanationBasisReference["type"]) => unique(bases.filter((basis) => basis.type === type).map((basis) => basis.id));
    const outcomeIds = unique(explanations.flatMap((explanation) => explanation.relatedOutcomeIds));
    const [observations, findings, syntheses, evaluations, decisions, outcomes] = await Promise.all([
      this.readObservations(idsOf("metric_observation")),
      this.readFindings(idsOf("finding"), at),
      this.readSyntheses(idsOf("synthesis")),
      this.readEvaluations(idsOf("evaluation")),
      this.readDecisions(idsOf("decision")),
      outcomeIds.length === 0
        ? Promise.resolve([])
        : this.database.selectFrom("outcome").select(["id", "title", "status"]).where("id", "in", idsSubquery(outcomeIds)).where("workspace_id", "=", workspaceId).execute(),
    ]);
    const resolve = (basis: IntentExplanationBasisReference): ResolvedIntentExplanationBasis => {
      switch (basis.type) {
        case "metric_observation": return { ...basis, type: "metric_observation", ...(observations.get(basis.id) ?? { state: "missing", detail: null }) };
        case "finding": return { ...basis, type: "finding", ...(findings.get(basis.id) ?? { state: "missing", detail: null }) };
        case "synthesis": return { ...basis, type: "synthesis", ...(syntheses.get(basis.id) ?? { state: "missing", detail: null }) };
        case "evaluation": return { ...basis, type: "evaluation", ...(evaluations.get(basis.id) ?? { state: "missing", detail: null }) };
        case "decision": return { ...basis, type: "decision", ...(decisions.get(basis.id) ?? { state: "missing", detail: null }) };
      }
    };
    return explanations.map(({ relatedOutcomeIds, ...explanation }) => {
      const items = explanation.items.map((item) => ({ ...item, basis: item.basis.map(resolve) }));
      return {
        ...explanation,
        items,
        relatedOutcomes: relatedOutcomeIds.flatMap((id) => {
          const outcome = outcomes.find((candidate) => candidate.id === id);
          return outcome ? [outcome] : [];
        }),
        basisOutdated: items.some((item) => item.basis.some((basis) => basis.state !== "current")),
      };
    });
  }

  private async readObservations(ids: string[]) {
    const result = new Map<string, { state: IntentExplanationBasisState; detail: Extract<ResolvedIntentExplanationBasis, { type: "metric_observation" }>["detail"] }>();
    if (ids.length === 0) return result;
    const rows = await this.database.selectFrom("intent_metric_observation").selectAll().select((eb) =>
      eb.selectFrom("intent_metric_observation as latest").select((inner) => inner.fn.max<number>("latest.revision").as("revision"))
        .whereRef("latest.metric_id", "=", "intent_metric_observation.metric_id")
        .whereRef("latest.period_start", "=", "intent_metric_observation.period_start")
        .whereRef("latest.period_end", "=", "intent_metric_observation.period_end").as("latest_revision"))
      .where("id", "in", idsSubquery(ids)).execute();
    for (const row of rows) {
      result.set(row.id, {
        state: (row.latest_revision ?? row.revision) > row.revision ? "revised" : "current",
        detail: {
          periodStart: row.period_start,
          periodEnd: row.period_end,
          revision: row.revision,
          status: row.status,
          value: row.value,
          failureReason: row.failure_reason,
          sourceName: row.source_name,
          observedAt: row.observed_at,
        },
      });
    }
    return result;
  }

  private async readFindings(ids: string[], at: number) {
    const result = new Map<string, { state: IntentExplanationBasisState; detail: Extract<ResolvedIntentExplanationBasis, { type: "finding" }>["detail"] }>();
    if (ids.length === 0) return result;
    const rows = await this.database.selectFrom("research_finding").selectAll().where("id", "in", idsSubquery(ids)).execute();
    for (const row of rows) {
      result.set(row.id, {
        state: row.expires_at !== null && row.expires_at <= at ? "expired" : "current",
        detail: { requestId: row.request_id, statement: row.statement, confidence: row.confidence, observedAt: row.observed_at, expiresAt: row.expires_at },
      });
    }
    return result;
  }

  private async readSyntheses(ids: string[]) {
    const result = new Map<string, { state: IntentExplanationBasisState; detail: Extract<ResolvedIntentExplanationBasis, { type: "synthesis" }>["detail"] }>();
    if (ids.length === 0) return result;
    const rows = await this.database.selectFrom("research_synthesis").selectAll().where("id", "in", idsSubquery(ids)).execute();
    const replaced = await this.database.selectFrom("research_synthesis").select("supersedes_id").where("supersedes_id", "in", idsSubquery(ids)).execute();
    const replacedIds = new Set(replaced.map((row) => row.supersedes_id));
    for (const row of rows) {
      result.set(row.id, {
        state: replacedIds.has(row.id) ? "superseded" : "current",
        detail: { requestId: row.request_id, version: row.version, conclusion: row.conclusion, validAsOf: row.valid_as_of },
      });
    }
    return result;
  }

  private async readEvaluations(ids: string[]) {
    const result = new Map<string, { state: IntentExplanationBasisState; detail: Extract<ResolvedIntentExplanationBasis, { type: "evaluation" }>["detail"] }>();
    if (ids.length === 0) return result;
    const rows = await this.database.selectFrom("outcome_evaluation").select(["id", "outcome_id", "result", "method", "created_at"]).where("id", "in", idsSubquery(ids)).execute();
    for (const row of rows) {
      result.set(row.id, { state: "current", detail: { outcomeId: row.outcome_id, result: row.result, method: row.method, createdAt: row.created_at } });
    }
    return result;
  }

  private async readDecisions(ids: string[]) {
    const result = new Map<string, { state: IntentExplanationBasisState; detail: Extract<ResolvedIntentExplanationBasis, { type: "decision" }>["detail"] }>();
    if (ids.length === 0) return result;
    const rows = await this.database.selectFrom("direction_decision").select(["id", "type", "judgment", "outcome_id", "created_at"]).where("id", "in", idsSubquery(ids)).execute();
    for (const row of rows) {
      result.set(row.id, { state: "current", detail: { decisionType: row.type, judgment: row.judgment, outcomeId: row.outcome_id, createdAt: row.created_at } });
    }
    return result;
  }
}
