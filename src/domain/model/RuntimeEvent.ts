import type { ResearchConclusion } from "./Research.ts";

/** Runtime向けイベントの形式version。項目の意味を変える場合に上げる。 */
export const runtimeEventVersion = 1;

/**
 * - `research_requested`: Research Requestが`requested`で確定した。RuntimeがResearcherを起動する条件。
 * - `research_completed`: Requestが`completed` / `insufficient` / `not_needed`で確定した。Runtimeが次にStrategistを起動する条件。
 *   `cancelled`はStrategistを起動する結果ではないためイベントを作らない。
 */
export type RuntimeEventType = "research_requested" | "research_completed";

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
  readonly researchRequestId: string;
  readonly correlationId: string;
  /** `research_completed`の確定結果。`research_requested`ではnull。 */
  readonly conclusion: ResearchConclusion | null;
  readonly occurredAt: number;
};
