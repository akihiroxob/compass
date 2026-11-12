import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import {
  SQLiteRuntimeEventRepository, planRuntimeEventAck,
  type DirectionDatabase, type RuntimeEventRepository, type AckRuntimeEventRecord, type RuntimeEventDelivery,
} from "@compass/direction";
import { ConflictError } from "@compass/shared";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

export class D1RuntimeEventRepository implements RuntimeEventRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<RuntimeEventRepository, "findAfter" | "findPending">;

  constructor(private readonly database: Kysely<DirectionDatabase>, binding: D1Database) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteRuntimeEventRepository(database);
  }

  findAfter(workspaceId: string, cursor: number, limit: number) { return this.reader.findAfter(workspaceId, cursor, limit); }
  findPending(workspaceId: string, consumerId: string, cursor: number, limit: number) {
    return this.reader.findPending(workspaceId, consumerId, cursor, limit);
  }

  async findResumeCursor(workspaceId: string, consumerId: string): Promise<number> {
    const row = await this.database.selectNoFrom(sql<number>`coalesce(
      (select min(event.sequence) - 1 from runtime_event as event left join runtime_event_delivery as delivery
        on delivery.event_sequence = event.sequence and delivery.consumer_id = ${consumerId}
        where event.workspace_id = ${workspaceId} and (delivery.outcome is null or delivery.outcome = 'retryable_failure')),
      (select max(sequence) from runtime_event where workspace_id = ${workspaceId}), 0)`.as("cursor")).executeTakeFirstOrThrow();
    return row.cursor;
  }

  async recordAck(input: Parameters<RuntimeEventRepository["recordAck"]>[0]): Promise<AckRuntimeEventRecord> {
    for (let retry = 0; retry < 3; retry++) {
      const eventQuery = this.database.selectFrom("runtime_event").selectAll().where("id", "=", input.eventId).where("workspace_id", "=", input.workspaceId);
      const event = await eventQuery.executeTakeFirst();
      if (!event) return { kind: "event_not_found" };
      const attemptQuery = this.database.selectFrom("runtime_event_ack_attempt").selectAll().where("consumer_id", "=", input.consumerId)
        .where("event_sequence", "=", event.sequence).where("attempt_id", "=", input.attemptId);
      const inputJson = JSON.stringify({ outcome: input.outcome, reason: input.reason });
      const attempt = await attemptQuery.executeTakeFirst();
      if (attempt) return attempt.input_json === inputJson
        ? { kind: "recorded", recorded: false, delivery: JSON.parse(attempt.result_json) as RuntimeEventDelivery }
        : { kind: "idempotency_conflict" };
      const deliveryQuery = this.database.selectFrom("runtime_event_delivery").selectAll().where("consumer_id", "=", input.consumerId).where("event_sequence", "=", event.sequence);
      const existing = await deliveryQuery.executeTakeFirst();
      const plan = planRuntimeEventAck(input, event, existing);
      if (plan.result.kind !== "recorded") return plan.result;
      const guards = [eventQuery.where("sequence", "=", event.sequence).compile(),
        sql`SELECT 1 WHERE NOT EXISTS ${attemptQuery}`.compile(this.database), existing
          ? deliveryQuery.where("outcome", "=", existing.outcome).where("retry_count", "=", existing.retry_count)
            .where("updated_at", "=", existing.updated_at).where("last_failure_reason", "is", existing.last_failure_reason).compile()
          : sql`SELECT 1 WHERE NOT EXISTS ${deliveryQuery}`.compile(this.database)];
      const mutations = [];
      if (plan.row) mutations.push(existing
        ? this.database.updateTable("runtime_event_delivery").set({ outcome: plan.row.outcome, retry_count: plan.row.retry_count,
          last_failure_reason: plan.row.last_failure_reason, updated_at: plan.row.updated_at })
          .where("consumer_id", "=", input.consumerId).where("event_sequence", "=", event.sequence).compile()
        : this.database.insertInto("runtime_event_delivery").values(plan.row).compile());
      mutations.push(this.database.insertInto("runtime_event_ack_attempt").values({ consumer_id: input.consumerId,
        event_sequence: event.sequence, attempt_id: input.attemptId, workspace_id: input.workspaceId,
        input_json: inputJson, result_json: JSON.stringify(plan.result.delivery), created_at: input.at }).compile());
      try {
        await this.atomic.execute(guards, mutations);
        return plan.result;
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Runtime event acknowledgement changed repeatedly", { eventId: input.eventId });
  }
}
