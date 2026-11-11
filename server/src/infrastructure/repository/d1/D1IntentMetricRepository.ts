import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable } from "kysely";
import { intentMetricFromRow, intentMetricObservationFromRow, sameIntentMetricObservationContent, latestIntentMetricRevisionOnly,
  type DirectionDatabase, type IntentMetricRepository, type DefineIntentMetricInput, type DefineIntentMetricResult,
  type IntentMetricObservationInput, type IntentMetricObservationRecord, type RecordIntentMetricObservationsResult,
  type IntentMetricSeriesRange, type IntentMetricTable, type IntentMetricObservationTable } from "@compass/direction";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

export class D1IntentMetricRepository implements IntentMetricRepository {
  private readonly atomic: D1AtomicBatch;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async define(workspaceId: string, intentId: string, principalId: string, input: DefineIntentMetricInput, at: number): Promise<DefineIntentMetricResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rejection = await this.rejection(workspaceId, intentId);
      if (rejection) return rejection;
      const query = this.metric(workspaceId, intentId, input.key);
      const existing = await query.executeTakeFirst();
      if (existing && existing.name === input.name && existing.unit === input.unit && existing.target_value === input.targetValue && existing.stale_after_days === input.staleAfterDays) {
        return { kind: "unchanged", metric: intentMetricFromRow(existing) };
      }
      const guards = this.changeGuards(workspaceId, intentId);
      if (existing) {
        guards.push(query.where("revision", "=", existing.revision).compile());
        if (existing.unit !== input.unit) {
          const observed = this.database.selectFrom("intent_metric_observation").select("id").where("metric_id", "=", existing.id);
          if (await observed.executeTakeFirst()) return { kind: "unit_locked", unit: existing.unit };
          guards.push(sql`SELECT 1 WHERE NOT EXISTS ${observed}`.compile(this.database));
        }
      } else guards.push(sql`SELECT 1 WHERE NOT EXISTS ${query}`.compile(this.database));
      const changes = { name: input.name, unit: input.unit, target_value: input.targetValue, stale_after_days: input.staleAfterDays,
        revision: (existing?.revision ?? 0) + 1, updated_at: at };
      const row: Selectable<IntentMetricTable> = existing ? { ...existing, ...changes } : { ...changes, id: crypto.randomUUID(),
        workspace_id: workspaceId, intent_id: intentId, key: input.key, created_by_principal_id: principalId, created_at: at };
      try {
        await this.atomic.execute(guards, [existing ? this.database.updateTable("intent_metric").set(changes).where("id", "=", existing.id).compile()
          : this.database.insertInto("intent_metric").values(row).compile()]);
        return { kind: existing ? "updated" : "created", metric: intentMetricFromRow(row) };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Intent Metric changed repeatedly during definition", { intentId, key: input.key });
  }

  async recordObservations(workspaceId: string, intentId: string, metricKey: string, principalId: string,
    observations: IntentMetricObservationInput[], at: number): Promise<RecordIntentMetricObservationsResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rejection = await this.rejection(workspaceId, intentId);
      if (rejection) return rejection;
      const metric = await this.metric(workspaceId, intentId, metricKey).executeTakeFirst();
      if (!metric) return { kind: "metric_not_found" };
      const guards = [...this.changeGuards(workspaceId, intentId), this.metric(workspaceId, intentId, metricKey).where("revision", "=", metric.revision).compile()];
      const mutations = [];
      const records: IntentMetricObservationRecord[] = [];
      for (const input of observations) {
        const query = this.database.selectFrom("intent_metric_observation").selectAll().where("metric_id", "=", metric.id)
          .where("period_start", "=", input.periodStart).where("period_end", "=", input.periodEnd);
        const revisions = await query.orderBy("revision", "desc").execute();
        const current = revisions[0];
        guards.push(current
          ? sql`SELECT 1 WHERE (SELECT MAX(revision) FROM intent_metric_observation WHERE metric_id = ${metric.id} AND period_start = ${input.periodStart} AND period_end = ${input.periodEnd}) = ${current.revision}`.compile(this.database)
          : sql`SELECT 1 WHERE NOT EXISTS ${query}`.compile(this.database));
        if (current && revisions.some((row) => sameIntentMetricObservationContent(row, input))) {
          records.push({ kind: "unchanged", observation: intentMetricObservationFromRow(current) });
          continue;
        }
        const row: Selectable<IntentMetricObservationTable> = { id: crypto.randomUUID(), metric_id: metric.id,
          period_start: input.periodStart, period_end: input.periodEnd, revision: (current?.revision ?? 0) + 1,
          status: input.status, value: input.value, failure_reason: input.failureReason, source_name: input.source.name,
          source_uri: input.source.uri, observed_at: input.observedAt, principal_id: principalId, recorded_at: at };
        mutations.push(this.database.insertInto("intent_metric_observation").values(row).compile());
        records.push({ kind: current ? "revised" : "created", observation: intentMetricObservationFromRow(row) });
      }
      try {
        // 再送だけの場合も同じsnapshotに基づく最新版を返すため、読取を含むbatchで前提検査する。
        await this.atomic.execute(guards, mutations.length ? mutations : [sql`SELECT 1`.compile(this.database)]);
        return { kind: "recorded", metric: intentMetricFromRow(metric), observations: records };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Intent Metric observations changed repeatedly", { intentId, metricKey });
  }

  async listByIntent(workspaceId: string, intentId: string, range: IntentMetricSeriesRange) {
    const metrics = this.database.selectFrom("intent_metric").selectAll().where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId)
      .orderBy("created_at").orderBy("id");
    const observations = this.database.selectFrom("intent_metric_observation").selectAll()
      .where("metric_id", "in", metrics.clearSelect().clearOrderBy().select("id")).where(latestIntentMetricRevisionOnly)
      .orderBy("period_start").orderBy("period_end");
    const queries = [this.intent(workspaceId, intentId), metrics, observations].map((query) => {
      const compiled = query.compile(); return this.binding.prepare(compiled.sql).bind(...compiled.parameters);
    });
    const results = await this.binding.batch(queries);
    if (!results[0]!.results.length) return null;
    const points = (results[2]!.results as Selectable<IntentMetricObservationTable>[]).map(intentMetricObservationFromRow);
    return (results[1]!.results as Selectable<IntentMetricTable>[]).map((row) => {
      const series = points.filter(({ metricId }) => metricId === row.id);
      const latest = [...series].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.periodStart.localeCompare(a.periodStart));
      return { metric: intentMetricFromRow(row), latest: latest[0] ?? null, lastObserved: latest.find(({ status }) => status === "observed") ?? null,
        series: series.filter(({ periodStart, periodEnd }) => periodEnd >= range.from && periodStart <= range.to) };
    });
  }

  private metric(workspaceId: string, intentId: string, key: string) { return this.database.selectFrom("intent_metric").selectAll().where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId).where("key", "=", key); }
  private intent(workspaceId: string, intentId: string) { return this.database.selectFrom("intent").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", intentId); }
  private writableWorkspace(workspaceId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
  private changeGuards(workspaceId: string, intentId: string) { return [this.writableWorkspace(workspaceId).compile(), this.intent(workspaceId, intentId).where("status", "=", "active").compile()]; }
  private async rejection(workspaceId: string, intentId: string) {
    if (!await this.writableWorkspace(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" as const };
    const intent = await this.intent(workspaceId, intentId).executeTakeFirst();
    if (!intent) return { kind: "intent_not_found" as const };
    return intent.status === "active" ? null : { kind: "intent_not_active" as const, status: intent.status };
  }
}
