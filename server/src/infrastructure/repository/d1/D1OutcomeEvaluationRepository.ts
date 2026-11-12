import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import { SQLiteOutcomeEvaluationRepository, outcomeEvaluationFromRow, outcomeEvaluationReplay, outcomeEvaluationRow,
  insertOutcomeEvaluatedEventQuery, snapshotEvaluationTargets, assessOutcomeEvaluability,
  type DirectionDatabase, type OutcomeEvaluationRepository, type RecordOutcomeEvaluationInput,
  type RecordOutcomeEvaluationResult, type OutcomeEvaluationRequest } from "@compass/direction";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { directionProjectReaders, directionWorkspaceReaders } from "../directionReaders.ts";
import type { D1DirectionActivityPlanner } from "./planD1DirectionActivity.ts";
import { readD1EvaluationTargets } from "./readD1EvaluationTargets.ts";

export class D1OutcomeEvaluationRepository implements OutcomeEvaluationRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<OutcomeEvaluationRepository, "findReplay" | "findByOutcome" | "findLatestByIntent">;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database, private readonly activity: D1DirectionActivityPlanner) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteOutcomeEvaluationRepository(database, directionWorkspaceReaders, directionProjectReaders);
  }
  findReplay(workspaceId: string, request: OutcomeEvaluationRequest) { return this.reader.findReplay(workspaceId, request); }
  findByOutcome(workspaceId: string, outcomeId: string) { return this.reader.findByOutcome(workspaceId, outcomeId); }
  findLatestByIntent(workspaceId: string, intentId: string) { return this.reader.findLatestByIntent(workspaceId, intentId); }

  async record(workspaceId: string, input: RecordOutcomeEvaluationInput): Promise<RecordOutcomeEvaluationResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sameKey = this.database.selectFrom("outcome_evaluation").selectAll().where("workspace_id", "=", workspaceId).where("request_key", "=", input.request.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) {
        const replay = outcomeEvaluationReplay(existing, input.request);
        if (replay.kind === "none") throw new Error("Existing evaluation must produce a replay or key conflict");
        return replay;
      }
      const archived = asOrganizationDatabase(this.database).selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
      if (await archived.executeTakeFirst()) return { kind: "workspace_archived" };
      const intentQuery = this.database.selectFrom("intent").select("status").where("id", "=", input.intentId).where("workspace_id", "=", workspaceId);
      const intent = await intentQuery.executeTakeFirstOrThrow();
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
      const outcomeQuery = this.database.selectFrom("outcome").select(["title", "status", "revision", "intent_version"])
        .where("workspace_id", "=", workspaceId).where("id", "=", input.request.outcomeId);
      const outcome = await outcomeQuery.executeTakeFirstOrThrow();
      if (outcome.status !== "active") return { kind: "outcome_not_active", status: outcome.status };
      const snapshot = await readD1EvaluationTargets(this.database, this.binding, workspaceId, input.request.outcomeId);
      if (assessOutcomeEvaluability(snapshot.targets).status !== "evaluable" || JSON.stringify(snapshotEvaluationTargets(snapshot.targets)) !== JSON.stringify(input.snapshot.targets)) return { kind: "targets_changed" };
      const row = outcomeEvaluationRow(workspaceId, input, outcome.intent_version);
      try {
        await this.atomic.execute([sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database), sql`SELECT 1 WHERE NOT EXISTS ${archived}`.compile(this.database),
          intentQuery.where("status", "=", "active").compile(), outcomeQuery.where("status", "=", "active").where("revision", "=", outcome.revision).where("intent_version", "=", outcome.intent_version).compile(),
          ...snapshot.guards], [this.database.insertInto("outcome_evaluation").values(row).compile(),
          insertOutcomeEvaluatedEventQuery(this.database, { workspaceId, intentId: input.intentId, outcomeId: input.request.outcomeId, evaluationId: row.id, occurredAt: input.at }).compile(),
          ...this.activity({ type: "outcome_evaluated", workspaceId, recordId: row.id, title: outcome.title,
            refs: [{ kind: "outcome", id: input.request.outcomeId }, { kind: "intent", id: input.intentId }], result: input.result, reason: null,
            principalId: input.request.principalId, occurredAt: input.at })]);
        return { kind: "created", evaluation: outcomeEvaluationFromRow(row) };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Outcome evaluation inputs changed repeatedly during recording", { outcomeId: input.request.outcomeId });
  }
}
