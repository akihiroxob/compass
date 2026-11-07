import type { Kysely, Selectable } from "kysely";
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
import type { DirectionDatabase, IntentExplanationTable } from "./schema.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";

type Executor = Kysely<DirectionDatabase>;

/** 一覧で返す説明の上限（新しい順）。 */
const listLimit = 50;

const basisColumn = {
  metric_observation: "observation_id",
  finding: "finding_id",
  synthesis: "synthesis_id",
  evaluation: "evaluation_id",
  decision: "decision_id",
} as const;

const unique = (values: string[]): string[] => [...new Set(values)];

/** 説明のrowから、項目・根拠・関連Outcomeを集めて組み立てる。 */
const loadExplanations = async (executor: Executor, rows: Selectable<IntentExplanationTable>[]): Promise<IntentExplanation[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [items, basis, outcomes] = await Promise.all([
    executor.selectFrom("intent_explanation_item").selectAll().where("explanation_id", "in", ids).orderBy("position", "asc").execute(),
    executor.selectFrom("intent_explanation_basis").selectAll().where("explanation_id", "in", ids).orderBy("item_position", "asc").orderBy("position", "asc").execute(),
    executor.selectFrom("intent_explanation_outcome").selectAll().where("explanation_id", "in", ids).orderBy("position", "asc").execute(),
  ]);
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    intentId: row.intent_id,
    metricKey: row.metric_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    version: row.version,
    previousId: row.previous_id,
    changeFromPrevious: row.change_from_previous,
    relatedOutcomeIds: outcomes.filter((outcome) => outcome.explanation_id === row.id).map((outcome) => outcome.outcome_id),
    items: items
      .filter((item) => item.explanation_id === row.id)
      .map((item) => ({
        position: item.position,
        kind: item.kind,
        statement: item.statement,
        confidence: item.confidence,
        verification: item.verification,
        basedOn: JSON.parse(item.based_on) as number[],
        basis: basis
          .filter((entry) => entry.explanation_id === row.id && entry.item_position === item.position)
          .map((entry): IntentExplanationBasisReference => {
            if (entry.observation_id !== null) return { type: "metric_observation", id: entry.observation_id };
            if (entry.finding_id !== null) return { type: "finding", id: entry.finding_id };
            if (entry.synthesis_id !== null) return { type: "synthesis", id: entry.synthesis_id };
            if (entry.evaluation_id !== null) return { type: "evaluation", id: entry.evaluation_id };
            return { type: "decision", id: entry.decision_id! };
          }),
      })),
    principalId: row.principal_id,
    runRef: row.run_ref,
    requestKey: row.request_key,
    createdAt: row.created_at,
  }));
};

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
        const [explanation] = await loadExplanations(transaction, [existing]);
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
      const missing = async (path: string, id: string, found: Promise<unknown>, message: string) => {
        if (!(await found)) references.push({ path, id, message });
      };
      for (const [itemIndex, item] of input.items.entries()) {
        for (const [basisIndex, basis] of item.basis.entries()) {
          const path = `items[${itemIndex}].basis[${basisIndex}]`;
          switch (basis.type) {
            case "metric_observation":
              await missing(path, basis.id, transaction.selectFrom("intent_metric_observation").select("id").where("id", "=", basis.id).where("metric_id", "=", metric.id).executeTakeFirst(), `metric_observation ${basis.id} was not found in Metric ${input.metricKey} of this Intent`);
              break;
            case "finding":
              await missing(path, basis.id, transaction.selectFrom("research_finding").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId).executeTakeFirst(), `finding ${basis.id} was not found in this Workspace`);
              break;
            case "synthesis":
              await missing(path, basis.id, transaction.selectFrom("research_synthesis").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId).executeTakeFirst(), `synthesis ${basis.id} was not found in this Workspace`);
              break;
            case "evaluation":
              await missing(path, basis.id, transaction.selectFrom("outcome_evaluation").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId).executeTakeFirst(), `evaluation ${basis.id} was not found for this Intent`);
              break;
            case "decision":
              await missing(path, basis.id, transaction.selectFrom("direction_decision").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId).executeTakeFirst(), `decision ${basis.id} was not found for this Intent`);
              break;
          }
        }
      }
      for (const [index, outcomeId] of input.relatedOutcomeIds.entries()) {
        await missing(`relatedOutcomeIds[${index}]`, outcomeId, transaction.selectFrom("outcome").select("id").where("id", "=", outcomeId).where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId).executeTakeFirst(), `outcome ${outcomeId} was not found for this Intent`);
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
      const row = await transaction
        .insertInto("intent_explanation")
        .values({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          intent_id: intentId,
          metric_key: input.metricKey,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          version: (previous?.version ?? 0) + 1,
          previous_id: previous?.id ?? null,
          // 初回は比較対象が無い。前回が無いのに変化を書かせない。
          change_from_previous: previous ? input.changeFromPrevious : null,
          principal_id: principalId,
          run_ref: input.runRef,
          request_key: input.requestKey,
          input_hash: hash,
          created_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const [position, item] of input.items.entries()) {
        await transaction
          .insertInto("intent_explanation_item")
          .values({
            explanation_id: row.id,
            position,
            kind: item.kind,
            statement: item.statement,
            confidence: item.confidence,
            verification: item.verification,
            based_on: JSON.stringify(item.basedOn),
          })
          .execute();
        for (const [basisPosition, basis] of item.basis.entries()) {
          await transaction
            .insertInto("intent_explanation_basis")
            .values({
              explanation_id: row.id,
              workspace_id: workspaceId,
              item_position: position,
              position: basisPosition,
              observation_id: null,
              finding_id: null,
              synthesis_id: null,
              evaluation_id: null,
              decision_id: null,
              [basisColumn[basis.type]]: basis.id,
            })
            .execute();
        }
      }
      for (const [position, outcomeId] of input.relatedOutcomeIds.entries()) {
        await transaction
          .insertInto("intent_explanation_outcome")
          .values({ explanation_id: row.id, workspace_id: workspaceId, outcome_id: outcomeId, position })
          .execute();
      }
      const [explanation] = await loadExplanations(transaction, [row]);
      return { kind: "recorded", explanation: explanation! };
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
    const explanations = await loadExplanations(this.database, rows);
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
        : this.database.selectFrom("outcome").select(["id", "title", "status"]).where("id", "in", outcomeIds).where("workspace_id", "=", workspaceId).execute(),
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
    const rows = await this.database.selectFrom("intent_metric_observation").selectAll().where("id", "in", ids).execute();
    for (const row of rows) {
      const latest = await this.database
        .selectFrom("intent_metric_observation")
        .select((builder) => builder.fn.max("revision").as("revision"))
        .where("metric_id", "=", row.metric_id)
        .where("period_start", "=", row.period_start)
        .where("period_end", "=", row.period_end)
        .executeTakeFirst();
      result.set(row.id, {
        state: (latest?.revision ?? row.revision) > row.revision ? "revised" : "current",
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
    const rows = await this.database.selectFrom("research_finding").selectAll().where("id", "in", ids).execute();
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
    const rows = await this.database.selectFrom("research_synthesis").selectAll().where("id", "in", ids).execute();
    const replaced = await this.database.selectFrom("research_synthesis").select("supersedes_id").where("supersedes_id", "in", ids).execute();
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
    const rows = await this.database.selectFrom("outcome_evaluation").select(["id", "outcome_id", "result", "method", "created_at"]).where("id", "in", ids).execute();
    for (const row of rows) {
      result.set(row.id, { state: "current", detail: { outcomeId: row.outcome_id, result: row.result, method: row.method, createdAt: row.created_at } });
    }
    return result;
  }

  private async readDecisions(ids: string[]) {
    const result = new Map<string, { state: IntentExplanationBasisState; detail: Extract<ResolvedIntentExplanationBasis, { type: "decision" }>["detail"] }>();
    if (ids.length === 0) return result;
    const rows = await this.database.selectFrom("direction_decision").select(["id", "type", "judgment", "outcome_id", "created_at"]).where("id", "in", ids).execute();
    for (const row of rows) {
      result.set(row.id, { state: "current", detail: { decisionType: row.type, judgment: row.judgment, outcomeId: row.outcome_id, createdAt: row.created_at } });
    }
    return result;
  }
}
