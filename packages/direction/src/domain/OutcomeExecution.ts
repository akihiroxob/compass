/**
 * Executionの結果区分。Success Criterionの充足とは別で、`accepted`でも成功条件を満たしたことにはならない
 * （成功条件の判定は、後続のEvaluationがEvidenceの観測結果で行う）。
 */
export type ExecutionState = "accepted" | "rejected" | "canceled" | "incomplete";

export const executionStates: readonly ExecutionState[] = ["accepted", "rejected", "canceled", "incomplete"];

export type ExecutionTaskCounts = {
  readonly todo: number;
  readonly doing: number;
  readonly in_review: number;
  readonly wait_accept: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly canceled: number;
};

export type ExecutionStoryResult = {
  readonly storyId: string;
  readonly status: string;
  readonly state: ExecutionState;
  readonly taskCounts: ExecutionTaskCounts;
};

/**
 * Outcomeごとに1件保持する、Executionの結果の要約。Story・Task・Commentの本文は複製しない。
 * 通知の順序や重複に左右されないよう、Execution側の最新Change cursor（`executionCursor`）が
 * 進むときだけ上書きする。
 */
export type OutcomeExecutionSummary = {
  readonly projectId: string;
  readonly outcomeId: string;
  /** DirectionがExecutionへ渡した相関ID（`outcome:{outcomeId}`）。 */
  readonly correlationId: string;
  readonly state: ExecutionState;
  readonly stories: readonly ExecutionStoryResult[];
  /** この要約が反映しているExecution（Wacha由来）のChange cursor。 */
  readonly executionCursor: number;
  /** Runtimeがこれまでに報告した最大のChange cursor。 */
  readonly observedCursor: number;
  readonly principalId: string;
  readonly updatedAt: number;
};

/** 取得元を辿れる参照の種類。Evidence本文は保持せず、参照先の種類だけを区別する。 */
export const executionEvidenceKinds = ["commit", "pull_request", "repository_file", "ci", "issue", "url"] as const;

export type ExecutionEvidenceKind = (typeof executionEvidenceKinds)[number];

/**
 * ExecutionがOutcomeへ残したEvidenceへの参照。本文は保持せず、取得元URI・version（commit SHA）・観測時刻・
 * 報告時のChange cursorだけを追跡する。作成後は変更しない。
 */
export type OutcomeExecutionEvidence = {
  readonly id: string;
  readonly projectId: string;
  readonly outcomeId: string;
  readonly kind: ExecutionEvidenceKind;
  readonly uri: string;
  /** 完全な40桁のcommit SHA。Evidenceが特定のcommitを指さない場合はnull。 */
  readonly versionHash: string | null;
  readonly observedAt: number;
  readonly sourceChangeCursor: number;
  readonly principalId: string;
  readonly createdAt: number;
};

/** Outcomeに保存された、Executionの要約とEvidence参照の読取モデル。 */
export type OutcomeExecutionRecord = {
  readonly summary: OutcomeExecutionSummary;
  readonly evidence: readonly OutcomeExecutionEvidence[];
};

/** 1 Outcomeに保持するEvidence参照の上限。参照の無制限な蓄積を防ぐ。 */
export const maximumEvidencePerOutcome = 200;
