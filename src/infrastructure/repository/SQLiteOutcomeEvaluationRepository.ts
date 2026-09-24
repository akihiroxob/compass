import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type { OutcomeEvaluation } from "../../domain/model/OutcomeEvaluation.ts";
import type {
  FindEvaluationReplayResult,
  OutcomeEvaluationRepository,
  OutcomeEvaluationRequest,
  RecordOutcomeEvaluationInput,
  RecordOutcomeEvaluationResult,
} from "../../domain/repository/OutcomeEvaluationRepository.ts";
import type { Database, OutcomeEvaluationTable } from "../database/schema.ts";
import { inputHash } from "./inputHash.ts";
import { isProjectArchived } from "./isProjectArchived.ts";
import { recordOutcomeEvaluatedEvent } from "./runtimeEventRecord.ts";

const toEvaluation = (row: Selectable<OutcomeEvaluationTable>): OutcomeEvaluation => ({
  id: row.id,
  projectId: row.project_id,
  outcomeId: row.outcome_id,
  intentId: row.intent_id,
  result: row.result,
  criteria: JSON.parse(row.criteria) as OutcomeEvaluation["criteria"],
  snapshot: JSON.parse(row.snapshot) as OutcomeEvaluation["snapshot"],
  principalId: row.principal_id,
  runRef: row.run_ref,
  requestKey: row.request_key,
  createdAt: row.created_at,
});

/** 判定の並び順・Evidence参照の並び順に依存しない、内容の同一性。導出した結果・snapshotは含めない。 */
const requestHash = (request: OutcomeEvaluationRequest): string =>
  inputHash({
    ...request,
    criteria: request.criteria
      .map((judgment) => ({ ...judgment, evidenceIds: [...judgment.evidenceIds].sort() }))
      .sort((left, right) => (left.criterionId < right.criterionId ? -1 : left.criterionId > right.criterionId ? 1 : 0)),
  });

type Reader = Kysely<Database> | Transaction<Database>;

const findByKey = (database: Reader, projectId: string, requestKey: string) =>
  database
    .selectFrom("outcome_evaluation")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("request_key", "=", requestKey)
    .executeTakeFirst();

const replayOf = (
  existing: Selectable<OutcomeEvaluationTable>,
  request: OutcomeEvaluationRequest,
): FindEvaluationReplayResult =>
  existing.input_hash === requestHash(request)
    ? { kind: "replayed", evaluation: toEvaluation(existing) }
    : { kind: "key_conflict", requestKey: request.requestKey };

export class SQLiteOutcomeEvaluationRepository implements OutcomeEvaluationRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async findReplay(projectId: string, request: OutcomeEvaluationRequest): Promise<FindEvaluationReplayResult> {
    const existing = await findByKey(this.database, projectId, request.requestKey);
    return existing ? replayOf(existing, request) : { kind: "none" };
  }

  async record(projectId: string, input: RecordOutcomeEvaluationInput): Promise<RecordOutcomeEvaluationResult> {
    return this.database.transaction().execute(async (transaction): Promise<RecordOutcomeEvaluationResult> => {
      const { request } = input;
      // 並行した再送は、先に保存された1件へ収束させる（archive後の再送も、保存済みの評価はそのまま返す）。
      const existing = await findByKey(transaction, projectId, request.requestKey);
      if (existing) {
        const replay = replayOf(existing, request);
        return replay.kind === "replayed" ? replay : { kind: "key_conflict", requestKey: request.requestKey };
      }
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };
      // 達成済み・中止したIntentのOutcomeを評価して、Strategistの起動（再計画）を誤って作らない。
      const intent = await transaction
        .selectFrom("intent")
        .select("status")
        .where("id", "=", input.intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirstOrThrow();
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };

      const row = await transaction
        .insertInto("outcome_evaluation")
        .values({
          id: crypto.randomUUID(),
          project_id: projectId,
          outcome_id: request.outcomeId,
          intent_id: input.intentId,
          result: input.result,
          criteria: JSON.stringify(input.criteria),
          snapshot: JSON.stringify(input.snapshot),
          principal_id: request.principalId,
          run_ref: request.runRef,
          request_key: request.requestKey,
          input_hash: requestHash(request),
          created_at: input.at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // 評価とStrategist起動の条件（outcome_evaluated）を同じtransactionで保存し、片方だけを残さない。
      await recordOutcomeEvaluatedEvent(transaction, {
        projectId,
        intentId: input.intentId,
        outcomeId: request.outcomeId,
        evaluationId: row.id,
        occurredAt: input.at,
      });
      return { kind: "created", evaluation: toEvaluation(row) };
    });
  }

  async findByOutcome(projectId: string, outcomeId: string): Promise<OutcomeEvaluation[]> {
    const rows = await this.database
      .selectFrom("outcome_evaluation")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("outcome_id", "=", outcomeId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return rows.map(toEvaluation);
  }

  async findLatestByIntent(projectId: string, intentId: string): Promise<OutcomeEvaluation[]> {
    const rows = await this.database
      .selectFrom("outcome_evaluation")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("intent_id", "=", intentId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    const latest = new Map<string, Selectable<OutcomeEvaluationTable>>();
    for (const row of rows) if (!latest.has(row.outcome_id)) latest.set(row.outcome_id, row);
    return [...latest.values()].map(toEvaluation);
  }
}
