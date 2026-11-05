import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type { IntentMetric, IntentMetricObservation } from "../domain/IntentMetric.ts";
import type {
  DefineIntentMetricInput,
  DefineIntentMetricResult,
  IntentMetricObservationInput,
  IntentMetricObservationRecord,
  IntentMetricRepository,
  IntentMetricSeriesRange,
  IntentMetricWithObservations,
  RecordIntentMetricObservationsResult,
} from "../domain/IntentMetricRepository.ts";
import type { IntentStatus } from "../domain/Intent.ts";
import type { DirectionDatabase, IntentMetricObservationTable, IntentMetricTable } from "./schema.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";

type Executor = Kysely<DirectionDatabase> | Transaction<DirectionDatabase>;

const toMetric = (row: Selectable<IntentMetricTable>): IntentMetric => ({
  id: row.id,
  workspaceId: row.workspace_id,
  intentId: row.intent_id,
  key: row.key,
  name: row.name,
  unit: row.unit,
  targetValue: row.target_value,
  staleAfterDays: row.stale_after_days,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toObservation = (row: Selectable<IntentMetricObservationTable>): IntentMetricObservation => ({
  id: row.id,
  metricId: row.metric_id,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  revision: row.revision,
  status: row.status,
  value: row.value,
  failureReason: row.failure_reason,
  source: { name: row.source_name, uri: row.source_uri },
  observedAt: row.observed_at,
  principalId: row.principal_id,
  recordedAt: row.recorded_at,
});

/** 記録者・記録時刻を除いた観測の内容。同じ内容の再送を新しい版にしない判定に使う。 */
const sameContent = (row: Selectable<IntentMetricObservationTable>, input: IntentMetricObservationInput): boolean =>
  row.status === input.status &&
  row.value === input.value &&
  row.failure_reason === input.failureReason &&
  row.source_name === input.source.name &&
  row.source_uri === input.source.uri &&
  row.observed_at === input.observedAt;

/** 各対象期間の最新版だけに絞る条件。 */
const latestRevisionOnly = sql<boolean>`intent_metric_observation.revision = (
  select max(latest.revision) from intent_metric_observation as latest
  where latest.metric_id = intent_metric_observation.metric_id
    and latest.period_start = intent_metric_observation.period_start
    and latest.period_end = intent_metric_observation.period_end
)`;

type IntentState =
  | { kind: "active" }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | { kind: "workspace_archived" };

export class SQLiteIntentMetricRepository implements IntentMetricRepository {
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly workspaces: DirectionWorkspaceReaders,
  ) {}

  /** 書込前の検査。Workspaceのarchiveを先に判定し、Intentは同じWorkspaceのactiveなものだけを受け付ける。 */
  private async intentState(transaction: Transaction<DirectionDatabase>, workspaceId: string, intentId: string): Promise<IntentState> {
    if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
    const intent = await transaction
      .selectFrom("intent")
      .select("status")
      .where("id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!intent) return { kind: "intent_not_found" };
    if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
    return { kind: "active" };
  }

  async define(
    workspaceId: string,
    intentId: string,
    principalId: string,
    input: DefineIntentMetricInput,
    at: number,
  ): Promise<DefineIntentMetricResult> {
    return this.database.transaction().execute(async (transaction): Promise<DefineIntentMetricResult> => {
      const state = await this.intentState(transaction, workspaceId, intentId);
      if (state.kind !== "active") return state;
      const existing = await transaction
        .selectFrom("intent_metric")
        .selectAll()
        .where("intent_id", "=", intentId)
        .where("key", "=", input.key)
        .executeTakeFirst();
      if (!existing) {
        const row = await transaction
          .insertInto("intent_metric")
          .values({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            intent_id: intentId,
            key: input.key,
            name: input.name,
            unit: input.unit,
            target_value: input.targetValue,
            stale_after_days: input.staleAfterDays,
            revision: 1,
            created_by_principal_id: principalId,
            created_at: at,
            updated_at: at,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { kind: "created", metric: toMetric(row) };
      }
      if (
        existing.name === input.name &&
        existing.unit === input.unit &&
        existing.target_value === input.targetValue &&
        existing.stale_after_days === input.staleAfterDays
      ) {
        return { kind: "unchanged", metric: toMetric(existing) };
      }
      if (existing.unit !== input.unit) {
        const observed = await transaction
          .selectFrom("intent_metric_observation")
          .select("id")
          .where("metric_id", "=", existing.id)
          .limit(1)
          .executeTakeFirst();
        if (observed) return { kind: "unit_locked", unit: existing.unit };
      }
      const row = await transaction
        .updateTable("intent_metric")
        .set({
          name: input.name,
          unit: input.unit,
          target_value: input.targetValue,
          stale_after_days: input.staleAfterDays,
          revision: existing.revision + 1,
          updated_at: at,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "updated", metric: toMetric(row) };
    });
  }

  async recordObservations(
    workspaceId: string,
    intentId: string,
    metricKey: string,
    principalId: string,
    observations: IntentMetricObservationInput[],
    at: number,
  ): Promise<RecordIntentMetricObservationsResult> {
    return this.database.transaction().execute(async (transaction): Promise<RecordIntentMetricObservationsResult> => {
      const state = await this.intentState(transaction, workspaceId, intentId);
      if (state.kind !== "active") return state;
      const metric = await transaction
        .selectFrom("intent_metric")
        .selectAll()
        .where("intent_id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .where("key", "=", metricKey)
        .executeTakeFirst();
      if (!metric) return { kind: "metric_not_found" };

      const records: IntentMetricObservationRecord[] = [];
      for (const input of observations) {
        const current = await transaction
          .selectFrom("intent_metric_observation")
          .selectAll()
          .where("metric_id", "=", metric.id)
          .where("period_start", "=", input.periodStart)
          .where("period_end", "=", input.periodEnd)
          .orderBy("revision", "desc")
          .limit(1)
          .executeTakeFirst();
        if (current && sameContent(current, input)) {
          records.push({ kind: "unchanged", observation: toObservation(current) });
          continue;
        }
        const row = await transaction
          .insertInto("intent_metric_observation")
          .values({
            id: crypto.randomUUID(),
            metric_id: metric.id,
            period_start: input.periodStart,
            period_end: input.periodEnd,
            revision: (current?.revision ?? 0) + 1,
            status: input.status,
            value: input.value,
            failure_reason: input.failureReason,
            source_name: input.source.name,
            source_uri: input.source.uri,
            observed_at: input.observedAt,
            principal_id: principalId,
            recorded_at: at,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        records.push({ kind: current ? "revised" : "created", observation: toObservation(row) });
      }
      return { kind: "recorded", metric: toMetric(metric), observations: records };
    });
  }

  async listByIntent(
    workspaceId: string,
    intentId: string,
    range: IntentMetricSeriesRange,
  ): Promise<IntentMetricWithObservations[] | null> {
    const intent = await this.database
      .selectFrom("intent")
      .select("id")
      .where("id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!intent) return null;
    const metrics = await this.database
      .selectFrom("intent_metric")
      .selectAll()
      .where("intent_id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return Promise.all(metrics.map(async (metric) => this.readObservations(this.database, metric, range)));
  }

  private async readObservations(
    executor: Executor,
    metric: Selectable<IntentMetricTable>,
    range: IntentMetricSeriesRange,
  ): Promise<IntentMetricWithObservations> {
    const latestOf = (status?: "observed") => {
      let query = executor
        .selectFrom("intent_metric_observation")
        .selectAll()
        .where("metric_id", "=", metric.id)
        .where(latestRevisionOnly);
      if (status) query = query.where("status", "=", status);
      return query.orderBy("period_end", "desc").orderBy("period_start", "desc").limit(1).executeTakeFirst();
    };
    // 範囲と重なる対象期間（終了が範囲の開始以後、開始が範囲の終了以前）の最新版。
    const series = executor
      .selectFrom("intent_metric_observation")
      .selectAll()
      .where("metric_id", "=", metric.id)
      .where("period_end", ">=", range.from)
      .where("period_start", "<=", range.to)
      .where(latestRevisionOnly)
      .orderBy("period_start", "asc")
      .orderBy("period_end", "asc")
      .execute();
    const [latest, lastObserved, points] = await Promise.all([latestOf(), latestOf("observed"), series]);
    return {
      metric: toMetric(metric),
      latest: latest ? toObservation(latest) : null,
      lastObserved: lastObserved ? toObservation(lastObserved) : null,
      series: points.map(toObservation),
    };
  }
}
