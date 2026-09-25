import type { ResearchConclusion } from "./Research.ts";

/** Runtime向けイベントの形式version。項目の意味を変える場合に上げる。 */
export const runtimeEventVersion = 1;


/**
 * - `research_requested`: Research Requestが`requested`で確定した。RuntimeがResearcherを起動する条件。
 * - `research_completed`: Requestが`completed` / `insufficient` / `not_needed`で確定した。Runtimeが次にStrategistを起動する条件。
 *   `cancelled`はStrategistを起動する結果ではないためイベントを作らない。
 * - `outcome_confirmed`: Outcome（固定のSuccess Criteriaを含む）が確定した。Runtimeが次にManagerを起動する条件。
 *   CompassはManagerを起動せず、StoryやTaskも作らない。ManagerがMCPの`issue_story`でOutcomeを参照して作る。
 * - `outcome_evaluated`: Outcome Evaluationが確定した（結果によらず1 Evaluationにつき1件）。Runtimeが次にStrategistを起動し、
 *   Evaluationを根拠に再計画（次のOutcome・追加Research）またはIntent完了を判断させる条件。Compassは判断しない。
 */
export type RuntimeEventType = "research_requested" | "research_completed" | "outcome_confirmed" | "outcome_evaluated";

/**
 * 状態変更と同一transactionで保存する、追記だけの確定イベント。
 * Compassは配送・polling・retry・timeoutを持たず、Runtimeが`cursor`を管理して差分を取得する。
 */
export type RuntimeEvent = {
  /** 全体で単調増加する取得位置。RuntimeはこれをafterCursorに渡して差分を取得する。 */
  readonly cursor: number;
  readonly id: string;
  readonly version: number;
  readonly type: RuntimeEventType;
  readonly projectId: string;
  /** 発端Intent。発端を持たない`project_watch`のRequestではnull。 */
  readonly intentId: string | null;
  /** research系イベントの発端Request。`outcome_confirmed`ではnull。 */
  readonly researchRequestId: string | null;
  /** `outcome_confirmed`で確定した・`outcome_evaluated`で評価したOutcome。research系イベントではnull。 */
  readonly outcomeId: string | null;
  /** `outcome_evaluated`で確定したEvaluation。Strategistが判断の根拠（`evaluationId`）に指定する。他のイベントではnull。 */
  readonly evaluationId: string | null;
  /**
   * research系は発端Requestの相関ID。Outcome系（`outcome_confirmed` / `outcome_evaluated`）は`outcome:{outcomeId}`で、
   * `issue_story`の既定の相関IDと一致する。
   */
  readonly correlationId: string;
  /** `research_completed`の確定結果。`research_requested`ではnull。 */
  readonly conclusion: ResearchConclusion | null;
  readonly occurredAt: number;
};
