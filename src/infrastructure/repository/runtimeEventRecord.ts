import type { Transaction } from "kysely";
import { runtimeEventVersion, type RuntimeEventType } from "../../domain/model/RuntimeEvent.ts";
import type { ResearchConclusion } from "../../domain/model/Research.ts";
import type { Database } from "../database/schema.ts";

/**
 * 確定イベントを、呼び出し元の状態変更と同じtransactionで追記する。
 * 同じRequest・同じ種類のイベントは1件に収束し、重複して呼んでも新しい行を作らない。
 */
export const recordRuntimeEvent = async (
  transaction: Transaction<Database>,
  event: {
    type: RuntimeEventType;
    projectId: string;
    intentId: string | null;
    researchRequestId: string;
    correlationId: string;
    conclusion: ResearchConclusion | null;
    occurredAt: number;
  },
): Promise<void> => {
  await transaction
    .insertInto("runtime_event")
    .values({
      id: crypto.randomUUID(),
      event_version: runtimeEventVersion,
      event_type: event.type,
      project_id: event.projectId,
      intent_id: event.intentId,
      research_request_id: event.researchRequestId,
      correlation_id: event.correlationId,
      conclusion: event.conclusion,
      created_at: event.occurredAt,
    })
    .onConflict((conflict) => conflict.columns(["research_request_id", "event_type"]).doNothing())
    .execute();
};
