import type { Selectable, Transaction } from "kysely";
import type { ResearchRequest } from "../../domain/model/Research.ts";
import type { CreateResearchRequestInput } from "../../shared/researchSchema.ts";
import type { Database, ResearchRequestTable } from "../database/schema.ts";
import { inputHash } from "./inputHash.ts";
import { recordRuntimeEvent } from "./runtimeEventRecord.ts";

export const toRequest = (row: Selectable<ResearchRequestTable>): ResearchRequest => ({
  id: row.id,
  projectId: row.project_id,
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
 * Requestの保存と`research_requested`イベントの追記を、必ず同じtransactionで行う唯一の経路。
 * 呼び出し側が存在・状態・冪等性（requestKey）を検査した後に呼ぶ。
 */
export const insertResearchRequest = async (
  transaction: Transaction<Database>,
  projectId: string,
  input: CreateResearchRequestInput,
  now: number,
): Promise<ResearchRequest> => {
  const row = await transaction
    .insertInto("research_request")
    .values({
      id: crypto.randomUUID(),
      project_id: projectId,
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
  await recordRuntimeEvent(transaction, {
    type: "research_requested",
    projectId,
    intentId: row.origin_intent_id,
    researchRequestId: row.id,
    correlationId: row.correlation_id,
    conclusion: null,
    occurredAt: now,
  });
  return toRequest(row);
};

export const findResearchRequestByKey = async (
  transaction: Transaction<Database>,
  projectId: string,
  requestKey: string,
): Promise<Selectable<ResearchRequestTable> | undefined> =>
  transaction
    .selectFrom("research_request")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("request_key", "=", requestKey)
    .executeTakeFirst();
