import type { Selectable, Transaction } from "kysely";
import type { ResearchRequest } from "../domain/Research.ts";
import type { CreateResearchRequestInput } from "../domain/ResearchRepository.ts";
import type { DirectionDatabase, ResearchRequestTable } from "./schema.ts";
import { inputHash } from "@compass/shared";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";

export const toRequest = (row: Selectable<ResearchRequestTable>): ResearchRequest => ({
  id: row.id,
  workspaceId: row.workspace_id,
  kind: row.kind,
  originIntentId: row.origin_intent_id,
  originOutcomeId: row.origin_outcome_id,
  question: row.question,
  scope: row.scope,
  completionCondition: row.completion_condition,
  budgetTotal: row.budget_total,
  budgetUsed: row.budget_used,
  deadlineAt: row.deadline_at,
  status: row.status,
  stopReason: row.stop_reason,
  correlationId: row.correlation_id,
  requestKey: row.request_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Requestの保存とWorkspace通知を同じtransactionで行う唯一の経路。
 * serverのobserverがcanonical ActivityとWorkspace Runtime eventへ投影する。
 * 呼び出し側が存在・状態・冪等性（requestKey）を検査した後に呼ぶ。
 */
export const insertResearchRequest = async (
  transaction: Transaction<DirectionDatabase>,
  workspaceId: string,
  input: CreateResearchRequestInput,
  now: number,
  observer: DirectionChangeObserver | null = null,
): Promise<ResearchRequest> => {
  const row = await transaction
    .insertInto("research_request")
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      request_key: input.requestKey,
      input_hash: inputHash(input),
      kind: input.kind,
      origin_intent_id: input.originIntentId,
      origin_outcome_id: input.originOutcomeId,
      question: input.question,
      scope: input.scope,
      completion_condition: input.completionCondition,
      budget_total: input.budgetTotal,
      budget_used: 0,
      deadline_at: input.deadlineAt,
      status: "requested",
      stop_reason: null,
      correlation_id: input.correlationId ?? crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await notifyDirectionChange(observer, transaction, {
    type: "research_requested",
    workspaceId,
    recordId: row.id,
    title: row.question,
    refs: [
      { kind: "research_request", id: row.id },
      ...(row.origin_intent_id ? [{ kind: "intent" as const, id: row.origin_intent_id }] : []),
      ...(row.origin_outcome_id ? [{ kind: "outcome" as const, id: row.origin_outcome_id }] : []),
    ],
    result: null,
    reason: null,
    principalId: null,
    occurredAt: now,
  });
  return toRequest(row);
};

export const findResearchRequestByKey = async (
  transaction: Transaction<DirectionDatabase>,
  workspaceId: string,
  requestKey: string,
): Promise<Selectable<ResearchRequestTable> | undefined> =>
  transaction
    .selectFrom("research_request")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("request_key", "=", requestKey)
    .executeTakeFirst();
