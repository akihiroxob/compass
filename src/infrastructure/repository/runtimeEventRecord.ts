import type { Transaction } from "kysely";
import { runtimeEventVersion, type RuntimeEventType } from "../../domain/model/RuntimeEvent.ts";
import { outcomeCorrelationId } from "../../shared/outcomeCorrelation.ts";
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

/**
 * Outcome確定を、Outcomeの保存と同じtransactionで追記する。相関IDは`outcome:{outcomeId}`で決定的にし、
 * RuntimeがManagerを起動して`issue_story`へ渡す相関IDと一致させる。同じOutcomeのイベントは1件に収束する。
 */
export const recordOutcomeConfirmedEvent = async (
  transaction: Transaction<Database>,
  outcome: { projectId: string; intentId: string; outcomeId: string; occurredAt: number },
): Promise<void> => {
  await transaction
    .insertInto("runtime_event")
    .values({
      id: crypto.randomUUID(),
      event_version: runtimeEventVersion,
      event_type: "outcome_confirmed",
      project_id: outcome.projectId,
      intent_id: outcome.intentId,
      research_request_id: null,
      outcome_id: outcome.outcomeId,
      correlation_id: outcomeCorrelationId(outcome.outcomeId),
      conclusion: null,
      created_at: outcome.occurredAt,
    })
    // 一意性はoutcome_confirmedに限った部分索引（runtime_event_outcome_confirmed_idx）が持つ。
    .onConflict((conflict) => conflict.doNothing())
    .execute();
};

/**
 * Outcome Evaluationの確定を、Evaluationの保存と同じtransactionで追記する。同じEvaluationのイベントは1件に収束し、
 * 再送（同じrequestKey）では呼ばれない。相関IDはOutcomeの`outcome:{outcomeId}`で、確定からExecution・評価までを1本で辿れる。
 */
export const recordOutcomeEvaluatedEvent = async (
  transaction: Transaction<Database>,
  evaluation: { projectId: string; intentId: string; outcomeId: string; evaluationId: string; occurredAt: number },
): Promise<void> => {
  await transaction
    .insertInto("runtime_event")
    .values({
      id: crypto.randomUUID(),
      event_version: runtimeEventVersion,
      event_type: "outcome_evaluated",
      project_id: evaluation.projectId,
      intent_id: evaluation.intentId,
      research_request_id: null,
      outcome_id: evaluation.outcomeId,
      evaluation_id: evaluation.evaluationId,
      correlation_id: outcomeCorrelationId(evaluation.outcomeId),
      conclusion: null,
      created_at: evaluation.occurredAt,
    })
    .onConflict((conflict) => conflict.column("evaluation_id").doNothing())
    .execute();
};
