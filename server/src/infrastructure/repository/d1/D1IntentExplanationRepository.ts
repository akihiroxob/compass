import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import { SQLiteIntentExplanationRepository, loadIntentExplanations, explanationReferenceQueries, planIntentExplanationRecord,
  type DirectionDatabase, type IntentExplanationRepository, type RecordIntentExplanationInput, type RecordIntentExplanationResult } from "@compass/direction";
import { ConflictError, inputHash } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { directionWorkspaceReaders } from "../directionReaders.ts";

export class D1IntentExplanationRepository implements IntentExplanationRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<IntentExplanationRepository, "listByIntent">;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteIntentExplanationRepository(database, directionWorkspaceReaders);
  }
  listByIntent(workspaceId: string, intentId: string, at: number) { return this.reader.listByIntent(workspaceId, intentId, at); }

  async record(workspaceId: string, intentId: string, principalId: string, input: RecordIntentExplanationInput, at: number): Promise<RecordIntentExplanationResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const archived = asOrganizationDatabase(this.database).selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
      if (await archived.executeTakeFirst()) return { kind: "workspace_archived" };
      const sameKey = this.database.selectFrom("intent_explanation").selectAll().where("workspace_id", "=", workspaceId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== inputHash({ intentId, ...input })) return { kind: "key_conflict", requestKey: input.requestKey };
        return { kind: "replayed", explanation: (await loadIntentExplanations(this.database, [existing]))[0]! };
      }
      const intentQuery = this.database.selectFrom("intent").select("status").where("workspace_id", "=", workspaceId).where("id", "=", intentId);
      const intent = await intentQuery.executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
      const metricQuery = this.database.selectFrom("intent_metric").select("id").where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId).where("key", "=", input.metricKey);
      const metric = await metricQuery.executeTakeFirst();
      if (!metric) return { kind: "metric_not_found" };
      const references = explanationReferenceQueries(this.database, workspaceId, intentId, metric.id, input);
      const checked = references.length ? await this.binding.batch(references.map(({ query }) => this.binding.prepare(query.sql).bind(...query.parameters))) : [];
      const missing = references.filter((_, index) => !checked[index]!.results.length).map(({ path, id, message }) => ({ path, id, message }));
      if (missing.length) return { kind: "invalid_reference", references: missing };
      const previous = await this.database.selectFrom("intent_explanation").select(["id", "version"]).where("intent_id", "=", intentId)
        .where("metric_key", "=", input.metricKey).orderBy("version", "desc").limit(1).executeTakeFirst();
      const plan = planIntentExplanationRecord(this.database, workspaceId, intentId, principalId, input, at, previous);
      try {
        await this.atomic.execute([sql`SELECT 1 WHERE NOT EXISTS ${archived}`.compile(this.database), sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database),
          intentQuery.where("status", "=", "active").compile(), metricQuery.compile(), ...references.map(({ query }) => query),
          sql`SELECT 1 WHERE COALESCE((SELECT MAX(version) FROM intent_explanation WHERE intent_id = ${intentId} AND metric_key = ${input.metricKey}), 0) = ${previous?.version ?? 0}`.compile(this.database)], plan.mutations);
        return { kind: "recorded", explanation: plan.explanation };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Intent explanation changed repeatedly during recording", { intentId, requestKey: input.requestKey });
  }
}
