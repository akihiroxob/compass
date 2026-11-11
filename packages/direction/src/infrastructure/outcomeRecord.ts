import { sql } from "kysely";
import type { CompiledQuery, Kysely, Selectable, Transaction } from "kysely";
import { ConflictError, ValidationError } from "@compass/shared";
import { Outcome, type EvaluationPlan, type EvaluationPlanInput, type OutcomeProblem, type ProblemEvidence, type SuccessCriterion } from "../domain/Outcome.ts";
import type { CreateOutcomeInput, OutcomeProblemInput } from "../domain/OutcomeRepository.ts";
import type { DirectionDatabase, OutcomeTable, OutcomeProblemTable, SuccessCriterionTable } from "./schema.ts";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";

type Executor = Kysely<DirectionDatabase> | Transaction<DirectionDatabase>;

const toCriterion = (row: Selectable<SuccessCriterionTable>): SuccessCriterion => ({
  id: row.id,
  outcomeId: row.outcome_id,
  position: row.position,
  description: row.description,
  measurement: row.measurement,
  target: row.target,
});

/** 課題と根拠参照をposition順で読み、根拠の要約・所属Request・置換の有無を参照先から解決する。 */
const loadProblems = async (database: Executor, outcomeIds: string[]): Promise<OutcomeProblem[]> => {
  const problems = await database
    .selectFrom("outcome_problem")
    .selectAll()
    .where("outcome_id", "in", outcomeIds)
    .orderBy("position", "asc")
    .execute();
  if (problems.length === 0) return [];
  const evidence = await database
    .selectFrom("outcome_problem_evidence as e")
    .leftJoin("research_finding as f", "f.id", "e.finding_id")
    .leftJoin("research_synthesis as s", "s.id", "e.synthesis_id")
    .select([
      "e.problem_id",
      "e.finding_id",
      "e.synthesis_id",
      "f.request_id as finding_request_id",
      "f.statement",
      "s.request_id as synthesis_request_id",
      "s.conclusion",
      (eb) =>
        eb
          .exists(eb.selectFrom("research_synthesis as newer").select("newer.id").whereRef("newer.supersedes_id", "=", "e.synthesis_id"))
          .as("superseded"),
    ])
    .where(
      "e.problem_id",
      "in",
      problems.map((problem) => problem.id),
    )
    .orderBy("e.position", "asc")
    .execute();
  return outcomeProblemsFromRecords(problems, evidence);
};

export type OutcomeEvidenceRecord = {
  problem_id: string; finding_id: string | null; synthesis_id: string | null;
  finding_request_id: string | null; statement: string | null;
  synthesis_request_id: string | null; conclusion: string | null; superseded: number | boolean;
};

export const outcomeProblemsFromRecords = (
  problems: Selectable<OutcomeProblemTable>[], evidence: OutcomeEvidenceRecord[],
): OutcomeProblem[] => {
  return problems.map((row) => ({
    id: row.id,
    outcomeId: row.outcome_id,
    position: row.position,
    statement: row.statement,
    evidenceStatus: row.evidence_status,
    observation: row.observation,
    causeHypothesis: row.cause_hypothesis,
    solutionHypothesis: row.solution_hypothesis,
    evaluationPlan: row.evaluation_plan === null ? null : (JSON.parse(row.evaluation_plan) as EvaluationPlan),
    evidence: evidence
      .filter((item) => item.problem_id === row.id)
      .map((item): ProblemEvidence =>
        item.finding_id !== null
          ? { kind: "research_finding", id: item.finding_id, requestId: item.finding_request_id ?? "", summary: item.statement ?? "", superseded: false }
          : { kind: "research_synthesis", id: item.synthesis_id ?? "", requestId: item.synthesis_request_id ?? "", summary: item.conclusion ?? "", superseded: Boolean(item.superseded) },
      ),
  }));
};

const planContent = ({ question, method, premises, observationPeriod, decisionCriteria, stopCriteria }: EvaluationPlanInput) =>
  JSON.stringify([question, method, premises, observationPeriod, decisionCriteria, stopCriteria]);

/** 内容が同じ計画は`planId`を引き継ぎ、追加・差替え・変更された計画には新しい`planId`を採番する。 */
const withPlanId = (plan: EvaluationPlanInput, previous: EvaluationPlan | null): EvaluationPlan => ({
  planId: previous !== null && planContent(previous) === planContent(plan) ? previous.planId : crypto.randomUUID(),
  question: plan.question,
  method: plan.method,
  premises: plan.premises,
  observationPeriod: plan.observationPeriod,
  decisionCriteria: plan.decisionCriteria,
  stopCriteria: plan.stopCriteria,
});

/**
 * 課題の一覧を置き換える。`id`付きの課題は同じOutcomeの既存の課題を引き継ぎ（作成日時を保つ）、他Outcomeの課題IDは拒否する。
 * 根拠は同じWorkspaceのFinding・Synthesisだけを受け付け、新たに関連付けるSynthesisが後の版に置き換え済みなら拒否する
 * （既に関連付け済みの参照は、その後に新しい版が出ても保持できる）。SQLは実行せず更新計画を返す。
 * transaction外で計画するときは、呼出側がOutcomeの版とpreconditionsを更新と同じ原子的batchで検査する。
 */
export const planOutcomeProblems = async (
  transaction: Executor,
  workspaceId: string,
  outcomeId: string,
  problems: OutcomeProblemInput[],
  now: number,
): Promise<{ preconditions: CompiledQuery[]; mutations: CompiledQuery[] }> => {
  const preconditions: CompiledQuery[] = [];
  const mutations: CompiledQuery[] = [];
  const existing = await transaction
    .selectFrom("outcome_problem")
    .select(["id", "created_at", "evaluation_plan"])
    .where("outcome_id", "=", outcomeId)
    .execute();
  const createdAt = new Map(existing.map((row) => [row.id, row.created_at]));
  const previousPlans = new Map(existing.map((row) => [row.id, row.evaluation_plan === null ? null : (JSON.parse(row.evaluation_plan) as EvaluationPlan)]));
  const linked = new Set(
    existing.length === 0
      ? []
      : (
          await transaction
            .selectFrom("outcome_problem_evidence")
            .select(["problem_id", "synthesis_id"])
            .where("problem_id", "in", transaction.selectFrom("outcome_problem").select("id").where("outcome_id", "=", outcomeId))
            .where("synthesis_id", "is not", null)
            .execute()
        ).map((row) => `${row.problem_id}:${row.synthesis_id}`),
  );
  const issues: { path: string; message: string }[] = [];
  for (const [index, problem] of problems.entries()) {
    if (problem.id !== undefined && !createdAt.has(problem.id)) {
      issues.push({ path: `problems.${index}.id`, message: "problem was not found in this Outcome" });
    }
  }
  if (issues.length > 0) throw new ValidationError("Outcome input is invalid", issues);

  for (const [index, problem] of problems.entries()) {
    for (const [position, reference] of problem.evidence.entries()) {
      const path = `problems.${index}.evidence.${position}.id`;
      if (reference.kind === "research_finding") {
        const findingQuery = transaction
          .selectFrom("research_finding")
          .select("id")
          .where("id", "=", reference.id)
          .where("workspace_id", "=", workspaceId);
        const finding = await findingQuery.executeTakeFirst();
        preconditions.push(findingQuery.compile());
        if (!finding) issues.push({ path, message: "research finding was not found in this Workspace" });
        continue;
      }
      const synthesisQuery = transaction
        .selectFrom("research_synthesis")
        .select("id")
        .where("id", "=", reference.id)
        .where("workspace_id", "=", workspaceId);
      const synthesis = await synthesisQuery.executeTakeFirst();
      preconditions.push(synthesisQuery.compile());
      if (!synthesis) {
        issues.push({ path, message: "research synthesis was not found in this Workspace" });
        continue;
      }
      const newerQuery = transaction
        .selectFrom("research_synthesis")
        .select("id")
        .where("supersedes_id", "=", reference.id);
      const newer = await newerQuery.executeTakeFirst();
      if (!(problem.id !== undefined && linked.has(`${problem.id}:${reference.id}`))) {
        preconditions.push(sql`SELECT 1 WHERE NOT EXISTS ${newerQuery}`.compile(transaction));
      }
      if (newer && !(problem.id !== undefined && linked.has(`${problem.id}:${reference.id}`))) {
        throw new ConflictError(
          `Research synthesis ${reference.id} has been superseded by ${newer.id}; link the latest version instead`,
          { conflict: "EVIDENCE_SUPERSEDED", path, synthesisId: reference.id, supersededBy: newer.id },
        );
      }
    }
  }
  if (issues.length > 0) throw new ValidationError("Outcome input is invalid", issues);

  mutations.push(transaction.deleteFrom("outcome_problem").where("outcome_id", "=", outcomeId).compile());
  for (const [position, problem] of problems.entries()) {
    const id = problem.id ?? crypto.randomUUID();
    mutations.push(transaction
      .insertInto("outcome_problem")
      .values({
        id,
        workspace_id: workspaceId,
        outcome_id: outcomeId,
        position,
        statement: problem.statement,
        evidence_status: problem.evidenceStatus,
        observation: problem.observation,
        cause_hypothesis: problem.causeHypothesis,
        solution_hypothesis: problem.solutionHypothesis,
        evaluation_plan: problem.evaluationPlan === null ? null : JSON.stringify(withPlanId(problem.evaluationPlan, previousPlans.get(id) ?? null)),
        created_at: createdAt.get(id) ?? now,
        updated_at: now,
      })
      .compile());
    for (const [index, reference] of problem.evidence.entries()) {
      mutations.push(transaction.insertInto("outcome_problem_evidence").values({
        problem_id: id,
        workspace_id: workspaceId,
        position: index,
        finding_id: reference.kind === "research_finding" ? reference.id : null,
        synthesis_id: reference.kind === "research_synthesis" ? reference.id : null,
      }).compile());
    }
  }
  return { preconditions, mutations };
};

export const replaceOutcomeProblems = async (
  transaction: Transaction<DirectionDatabase>, workspaceId: string, outcomeId: string, problems: OutcomeProblemInput[], now: number,
): Promise<void> => {
  const plan = await planOutcomeProblems(transaction, workspaceId, outcomeId, problems, now);
  for (const query of plan.mutations) await transaction.executeQuery(query);
};

/** OutcomeのrowにSuccess Criterion・課題をposition順で結び付ける。 */
export const loadOutcomes = async (
  database: Executor,
  rows: Selectable<OutcomeTable>[],
): Promise<Outcome[]> => {
  if (rows.length === 0) return [];
  const problems = await loadProblems(
    database,
    rows.map((row) => row.id),
  );
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
  return outcomesFromRecords(rows, criteria, problems);
};

export const outcomesFromRecords = (
  rows: Selectable<OutcomeTable>[], criteria: Selectable<SuccessCriterionTable>[], problems: OutcomeProblem[],
): Outcome[] => {
  return rows.map(
    (row) =>
      new Outcome({
        id: row.id,
        workspaceId: row.workspace_id,
        intentId: row.intent_id,
        intentVersion: row.intent_version,
        title: row.title,
        description: row.description,
        hypothesis: row.hypothesis,
        rationale: row.rationale,
        status: row.status,
        cancelReason: row.cancel_reason,
        successCriteria: criteria.filter((item) => item.outcome_id === row.id).map(toCriterion),
        problems: problems.filter((item) => item.outcomeId === row.id),
        revision: row.revision,
        originDecisionId: row.origin_decision_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
  );
};

/**
 * OutcomeとSuccess Criterionを1 transactionで挿入する。`id`・`originDecisionId`は呼び出し側が決める
 * （decideNextOutcomeはDecision行を作る前にOutcomeのIDを確定させ、Decision.outcomeIdのFKに使う）。
 * 存在・状態の確認は呼び出し側が行う。Workspace通知を同じtransactionで送る。
 * serverがcanonical ActivityとWorkspace Runtime eventへ投影し、通知先の失敗時はOutcome・成功条件も巻き戻る。
 */
export const insertOutcomeRow = async (
  transaction: Transaction<DirectionDatabase>,
  workspaceId: string,
  intentId: string,
  id: string,
  originDecisionId: string | null,
  input: CreateOutcomeInput,
  now: number,
  observer: DirectionChangeObserver | null = null,
): Promise<Outcome> => {
  const intent = await transaction
    .selectFrom("intent")
    .select("version")
    .where("id", "=", intentId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const row = await transaction
    .insertInto("outcome")
    .values({
      id,
      workspace_id: workspaceId,
      intent_id: intentId,
      intent_version: intent.version,
      title: input.title,
      description: input.description,
      hypothesis: input.hypothesis,
      rationale: input.rationale,
      status: "active",
      cancel_reason: null,
      origin_decision_id: originDecisionId,
      revision: 1,
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
  await replaceOutcomeProblems(transaction, workspaceId, row.id, input.problems, now);
  await notifyDirectionChange(observer, transaction, {
    type: "outcome_confirmed",
    workspaceId,
    recordId: row.id,
    title: row.title,
    refs: [
      { kind: "outcome", id: row.id },
      { kind: "intent", id: intentId },
      ...(originDecisionId ? [{ kind: "decision" as const, id: originDecisionId }] : []),
    ],
    result: null,
    reason: null,
    principalId: null,
    occurredAt: now,
  });
  const [outcome] = await loadOutcomes(transaction, [row]);
  return outcome!;
};
