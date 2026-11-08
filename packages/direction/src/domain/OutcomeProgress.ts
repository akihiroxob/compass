import type { ExecutionTaskCounts } from "./OutcomeExecution.ts";

/** 状態別のTask件数（読取専用）。 */
export type TaskCounts = ExecutionTaskCounts;
type MutableCounts = { -readonly [Key in keyof TaskCounts]: TaskCounts[Key] };

/**
 * OutcomeのTask進捗の集計規則。一覧と詳細は同じ関数を使う。
 *
 * - 対象は、Target ProjectのStoryのうちOutcomeへ相関付いた（`outcome_ref`）ものに属するTaskだけ。Outcome未設定のStory・Taskは数えない。
 * - 分母は取消（canceled）を除くTask数、分子は受入済み（accepted）。取消は分母に含めず、件数として別に示す（総数 = 分母 + 取消）。
 * - 分母が0なら割合は`null`。0%や100%にしない。
 * - 検索・絞り込みは表示するOutcomeを選ぶだけで、集計は変えない。
 * - 割合はTask進捗であり、Outcomeの達成度・効果ではない。提供状況・効果の確認はEvaluationが別に示す。
 */
export type TaskProgressKind =
  /** Target Projectが無い（Strategistの判断待ち）。進捗の対象がない。 */
  | "no_target"
  /** Targetはあるが、相関付いたStoryがまだ無い（未起票）。 */
  | "not_planned"
  /** Storyはあるが、Taskが0件、または全て取消で分母が0件。 */
  | "no_countable_tasks"
  /** 分母が1件以上ある。 */
  | "counted";

export type TaskProgress = {
  kind: TaskProgressKind;
  accepted: number;
  /** 取消を除くTask数（割合の分母）。 */
  denominator: number;
  canceled: number;
  /** 取消を含む総数。 */
  total: number;
  counts: TaskCounts;
  /** accepted / denominator（0〜1）。分母が0ならnull。 */
  ratio: number | null;
};

export const emptyTaskCounts = (): MutableCounts => ({
  todo: 0,
  doing: 0,
  in_review: 0,
  wait_accept: 0,
  accepted: 0,
  rejected: 0,
  canceled: 0,
});

export const addTaskCounts = (left: TaskCounts, right: TaskCounts): TaskCounts => {
  const sum = emptyTaskCounts();
  for (const key of Object.keys(sum) as (keyof MutableCounts)[]) sum[key] = left[key] + right[key];
  return sum;
};

/** Task数の集計。`planned`はStoryが1件以上あるか、`hasTarget`はTargetがあるか。 */
export const summarizeTaskProgress = (
  hasTarget: boolean,
  planned: boolean,
  counts: TaskCounts,
): TaskProgress => {
  const canceled = counts.canceled;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const denominator = total - canceled;
  const kind: TaskProgressKind = !hasTarget ? "no_target" : !planned ? "not_planned" : denominator === 0 ? "no_countable_tasks" : "counted";
  return {
    kind,
    accepted: counts.accepted,
    denominator,
    canceled,
    total,
    counts,
    ratio: denominator === 0 ? null : counts.accepted / denominator,
  };
};
