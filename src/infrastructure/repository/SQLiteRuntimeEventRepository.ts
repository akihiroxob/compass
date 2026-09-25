import type { Kysely, Selectable, Transaction } from "kysely";
import type { RuntimeEvent } from "../../domain/model/RuntimeEvent.ts";
import {
  isSettledAckOutcome,
  type PendingRuntimeEvent,
  type RuntimeEventDelivery,
} from "../../domain/model/RuntimeEventDelivery.ts";
import type { AckRuntimeEventRecord, RuntimeEventRepository } from "../../domain/repository/RuntimeEventRepository.ts";
import type { Database, RuntimeEventDeliveryTable, RuntimeEventTable } from "../database/schema.ts";

const toRuntimeEvent = (row: Selectable<RuntimeEventTable>): RuntimeEvent => ({
  cursor: row.sequence,
  id: row.id,
  version: row.event_version,
  type: row.event_type,
  projectId: row.project_id,
  intentId: row.intent_id,
  researchRequestId: row.research_request_id,
  outcomeId: row.outcome_id,
  evaluationId: row.evaluation_id,
  correlationId: row.correlation_id,
  conclusion: row.conclusion,
  occurredAt: row.created_at,
});

const toDelivery = (
  row: Selectable<RuntimeEventDeliveryTable>,
  event: Selectable<RuntimeEventTable>,
): RuntimeEventDelivery => ({
  consumerId: row.consumer_id,
  eventId: event.id,
  cursor: row.event_sequence,
  outcome: row.outcome,
  retryCount: row.retry_count,
  lastFailureReason: row.last_failure_reason,
  updatedAt: row.updated_at,
});

export class SQLiteRuntimeEventRepository implements RuntimeEventRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async findAfter(projectId: string, afterCursor: number, limit: number): Promise<RuntimeEvent[]> {
    const rows = await this.database
      .selectFrom("runtime_event")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("sequence", ">", afterCursor)
      .orderBy("sequence", "asc")
      .limit(limit)
      .execute();
    return rows.map(toRuntimeEvent);
  }

  async findPending(
    projectId: string,
    consumerId: string,
    afterCursor: number,
    limit: number,
  ): Promise<PendingRuntimeEvent[]> {
    const rows = await this.database
      .selectFrom("runtime_event as event")
      .leftJoin("runtime_event_delivery as delivery", (join) =>
        join.onRef("delivery.event_sequence", "=", "event.sequence").on("delivery.consumer_id", "=", consumerId),
      )
      .selectAll("event")
      .select(["delivery.retry_count as retry_count", "delivery.last_failure_reason as last_failure_reason"])
      .where("event.project_id", "=", projectId)
      .where("event.sequence", ">", afterCursor)
      .where((eb) => eb.or([eb("delivery.outcome", "is", null), eb("delivery.outcome", "=", "retryable_failure")]))
      .orderBy("event.sequence", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      ...toRuntimeEvent(row),
      retryCount: row.retry_count ?? 0,
      lastFailureReason: row.last_failure_reason,
    }));
  }

  async findResumeCursor(projectId: string, consumerId: string): Promise<number> {
    return this.database.transaction().execute(async (transaction) => {
      // 先に最新のcursorを読み、その範囲で最古の未確定イベントを探す。後から追記されたイベントは最新より大きいため、
      // 読んでいる間に追記されても、未ackのイベントを再開位置が追い越さない。
      const latest = await transaction
        .selectFrom("runtime_event")
        .select((eb) => eb.fn.max("sequence").as("sequence"))
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      const head = latest?.sequence ?? 0;
      const oldest = await transaction
        .selectFrom("runtime_event as event")
        .leftJoin("runtime_event_delivery as delivery", (join) =>
          join.onRef("delivery.event_sequence", "=", "event.sequence").on("delivery.consumer_id", "=", consumerId),
        )
        .select((eb) => eb.fn.min("event.sequence").as("sequence"))
        .where("event.project_id", "=", projectId)
        .where("event.sequence", "<=", head)
        .where((eb) => eb.or([eb("delivery.outcome", "is", null), eb("delivery.outcome", "=", "retryable_failure")]))
        .executeTakeFirst();
      return oldest?.sequence == null ? head : oldest.sequence - 1;
    });
  }

  async recordAck(input: Parameters<RuntimeEventRepository["recordAck"]>[0]): Promise<AckRuntimeEventRecord> {
    return this.database.transaction().execute(async (transaction): Promise<AckRuntimeEventRecord> => {
      // Projectの一致もここで確かめる。別Projectのイベントは存在しないものとして扱い、存在を漏らさない。
      const event = await transaction
        .selectFrom("runtime_event")
        .selectAll()
        .where("id", "=", input.eventId)
        .where("project_id", "=", input.projectId)
        .executeTakeFirst();
      if (!event) return { kind: "event_not_found" };

      // 同じattemptIdの再送は、応答が失われた同じ試行として初回の結果を返す。retryable_failureを二重に数えない。
      const inputJson = JSON.stringify({ outcome: input.outcome, reason: input.reason });
      const attempt = await transaction
        .selectFrom("runtime_event_ack_attempt")
        .selectAll()
        .where("consumer_id", "=", input.consumerId)
        .where("event_sequence", "=", event.sequence)
        .where("attempt_id", "=", input.attemptId)
        .executeTakeFirst();
      if (attempt) {
        if (attempt.input_json !== inputJson) return { kind: "idempotency_conflict" };
        return { kind: "recorded", recorded: false, delivery: JSON.parse(attempt.result_json) as RuntimeEventDelivery };
      }

      const result = await this.applyAck(transaction, input, event);
      if (result.kind === "recorded") {
        await transaction
          .insertInto("runtime_event_ack_attempt")
          .values({
            consumer_id: input.consumerId,
            event_sequence: event.sequence,
            attempt_id: input.attemptId,
            project_id: input.projectId,
            input_json: inputJson,
            result_json: JSON.stringify(result.delivery),
            created_at: input.at,
          })
          .execute();
      }
      return result;
    });
  }

  private async applyAck(
    transaction: Transaction<Database>,
    input: Parameters<RuntimeEventRepository["recordAck"]>[0],
    event: Selectable<RuntimeEventTable>,
  ): Promise<AckRuntimeEventRecord> {
    const key = { consumer_id: input.consumerId, event_sequence: event.sequence };
    const existing = await transaction
      .selectFrom("runtime_event_delivery")
      .selectAll()
      .where("consumer_id", "=", key.consumer_id)
      .where("event_sequence", "=", key.event_sequence)
      .executeTakeFirst();

    if (!existing) {
      const row = {
        ...key,
        project_id: input.projectId,
        outcome: input.outcome,
        retry_count: input.outcome === "retryable_failure" ? 1 : 0,
        last_failure_reason: input.reason,
        created_at: input.at,
        updated_at: input.at,
      };
      await transaction.insertInto("runtime_event_delivery").values(row).execute();
      return { kind: "recorded", recorded: true, delivery: toDelivery(row, event) };
    }

    if (isSettledAckOutcome(existing.outcome)) {
      // 確定済み。別attemptIdでも同じ結果なら何も変えず既存の記録を返し、別の結果への変更は拒否する。
      return existing.outcome === input.outcome
        ? { kind: "recorded", recorded: false, delivery: toDelivery(existing, event) }
        : { kind: "conflict", current: existing.outcome };
    }

    const updated = {
      ...existing,
      outcome: input.outcome,
      retry_count: existing.retry_count + (input.outcome === "retryable_failure" ? 1 : 0),
      // processedへ進むときは、再試行の履歴（回数・最後の理由）を残す。
      last_failure_reason: input.outcome === "processed" ? existing.last_failure_reason : input.reason,
      updated_at: input.at,
    };
    await transaction
      .updateTable("runtime_event_delivery")
      .set({
        outcome: updated.outcome,
        retry_count: updated.retry_count,
        last_failure_reason: updated.last_failure_reason,
        updated_at: updated.updated_at,
      })
      .where("consumer_id", "=", key.consumer_id)
      .where("event_sequence", "=", key.event_sequence)
      .execute();
    return { kind: "recorded", recorded: true, delivery: toDelivery(updated, event) };
  }
}
