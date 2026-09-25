import type { Kysely, Selectable, Transaction } from "kysely";
import { Outcome, type SuccessCriterion } from "../../domain/model/Outcome.ts";
import type { CreateOutcomeInput } from "../../shared/outcomeSchema.ts";
import type { Database, OutcomeTable, SuccessCriterionTable } from "../database/schema.ts";
import { recordOutcomeConfirmedEvent } from "./runtimeEventRecord.ts";

type Executor = Kysely<Database> | Transaction<Database>;

const toCriterion = (row: Selectable<SuccessCriterionTable>): SuccessCriterion => ({
  id: row.id,
  outcomeId: row.outcome_id,
  position: row.position,
  description: row.description,
  measurement: row.measurement,
  target: row.target,
});

/** OutcomeのrowにSuccess Criterionをposition順で結び付ける。 */
export const loadOutcomes = async (
  database: Executor,
  rows: Selectable<OutcomeTable>[],
): Promise<Outcome[]> => {
  if (rows.length === 0) return [];
  const criteria = await database
    .selectFrom("success_criterion")
    .selectAll()
    .where(
      "outcome_id",
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("position", "asc")
    .execute();
  return rows.map(
    (row) =>
      new Outcome({
        id: row.id,
        projectId: row.project_id,
        intentId: row.intent_id,
        title: row.title,
        description: row.description,
        hypothesis: row.hypothesis,
        rationale: row.rationale,
        status: row.status,
        cancelReason: row.cancel_reason,
        successCriteria: criteria.filter((item) => item.outcome_id === row.id).map(toCriterion),
        originDecisionId: row.origin_decision_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
  );
};

/**
 * OutcomeとSuccess Criterionを1 transactionで挿入する。`id`・`originDecisionId`は呼び出し側が決める
 * （decideNextOutcomeはDecision行を作る前にOutcomeのIDを確定させ、Decision.outcomeIdのFKに使う）。
 * 存在・状態の確認は呼び出し側が行う。あわせて`outcome_confirmed`イベントを同じtransactionで保存するため、
 * Outcomeとイベントの一方だけが残ることはない（create_outcome・decide_next_outcomeの両方がここを通る）。
 */
export const insertOutcomeRow = async (
  transaction: Transaction<Database>,
  projectId: string,
  intentId: string,
  id: string,
  originDecisionId: string | null,
  input: CreateOutcomeInput,
  now: number,
): Promise<Outcome> => {
  const row = await transaction
    .insertInto("outcome")
    .values({
      id,
      project_id: projectId,
      intent_id: intentId,
      title: input.title,
      description: input.description,
      hypothesis: input.hypothesis,
      rationale: input.rationale,
      status: "active",
      cancel_reason: null,
      origin_decision_id: originDecisionId,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("success_criterion")
    .values(
      input.successCriteria.map((criterion, position) => ({
        id: crypto.randomUUID(),
        outcome_id: row.id,
        position,
        description: criterion.description,
        measurement: criterion.measurement,
        target: criterion.target,
        created_at: now,
      })),
    )
    .execute();
  await recordOutcomeConfirmedEvent(transaction, { projectId, intentId, outcomeId: row.id, occurredAt: now });
  const [outcome] = await loadOutcomes(transaction, [row]);
  return outcome!;
};
