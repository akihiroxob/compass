import type { ExecutionEvidenceKind, ExecutionState, ExecutionStoryResult } from "./OutcomeExecution.ts";

/** Success Criterion 1件の観測結果。証拠が無いものを`met` / `not_met`と推測せず、`insufficient_evidence`で残す。 */
export const criterionVerdicts = ["met", "not_met", "insufficient_evidence"] as const;

export type CriterionVerdict = (typeof criterionVerdicts)[number];

/** Outcome全体の評価結果。Executionの`accepted`ではなく、Criterionごとの観測結果から導出する。 */
export type EvaluationResult = "achieved" | "failed" | "insufficient_evidence";

/**
 * Criterionの判定から総合結果を導出する。Evaluatorが総合結果を直接指定すると判定と食い違い得るため、導出に固定する。
 * - すべて`met`だけが`achieved`
 * - 1つでも`not_met`があれば`failed`（他のCriterionが`insufficient_evidence`でも、Outcomeは達成できていない）
 * - `not_met`が無く、`met`以外が`insufficient_evidence`だけなら`insufficient_evidence`
 */
export const deriveEvaluationResult = (verdicts: readonly CriterionVerdict[]): EvaluationResult => {
  if (verdicts.includes("not_met")) return "failed";
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "met")) return "achieved";
  return "insufficient_evidence";
};

/** 評価したCriterion。定義（description・measurement・target・position）は評価時のsnapshotで、Outcomeの固定値と同じ。 */
export type CriterionEvaluation = {
  criterionId: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
  verdict: CriterionVerdict;
  rationale: string;
  /** 判定の根拠にしたExecution Evidence（`OutcomeExecutionEvidence.id`）。`insufficient_evidence`では空でよい。 */
  evidenceIds: string[];
};

/** 評価時点のEvidence参照。本文は持たない。 */
export type EvaluationEvidenceSnapshot = {
  id: string;
  kind: ExecutionEvidenceKind;
  uri: string;
  versionHash: string | null;
  observedAt: number;
};

/** 評価に使った入力の、評価時点の写し。後からExecutionが進んでも、何を根拠に評価したかを辿れる。 */
export type EvaluationSnapshot = {
  outcome: { title: string; description: string; hypothesis: string | null; status: string };
  execution: {
    correlationId: string;
    state: ExecutionState;
    stories: readonly ExecutionStoryResult[];
    executionCursor: number;
    observedCursor: number;
  };
  evidence: EvaluationEvidenceSnapshot[];
};

/** Outcomeごとに追記する評価。作成後は変更しない（再評価は新しい行で、最新の評価が現在の結果）。 */
export type OutcomeEvaluation = {
  id: string;
  projectId: string;
  outcomeId: string;
  intentId: string;
  result: EvaluationResult;
  criteria: CriterionEvaluation[];
  snapshot: EvaluationSnapshot;
  principalId: string;
  runRef: string;
  requestKey: string;
  createdAt: number;
};
