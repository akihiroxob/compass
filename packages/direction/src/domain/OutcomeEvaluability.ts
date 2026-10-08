import type { OutcomeExecutionRecord } from "./OutcomeExecution.ts";
import type { OutcomeTargetProjectView } from "./OutcomeTargetProject.ts";

/** Target 1件と、そのProjectからOutcomeへ還流済みのExecution Summary・Evidence参照。未還流なら`execution`はnull。 */
export type OutcomeTargetExecution = OutcomeTargetProjectView & { execution: OutcomeExecutionRecord | null };

/**
 * Outcomeを評価できるかの区分。
 * - `evaluable`: 全TargetからSummaryが還流し、`incomplete`が無い。Evaluatorが全Targetのsnapshotで評価する
 * - `no_targets`: Targetが無い。担当Projectの判断はStrategistへ戻る
 * - `replan_required`: archivedのTargetに未完了のExecutionが残る。そのProjectからは還流が進まないため、Strategistが再計画する
 * - `awaiting_execution`: activeなTargetの還流待ち・Execution中。評価もStrategistの再計画もしない
 */
export const outcomeEvaluabilityStatuses = ["evaluable", "no_targets", "replan_required", "awaiting_execution"] as const;

export type OutcomeEvaluabilityStatus = (typeof outcomeEvaluabilityStatuses)[number];

/** 評価を妨げているTarget。`not_reflected`はSummary未還流、`incomplete`は還流済みだがExecutionが終わっていない。 */
export type UnfinishedOutcomeTarget = {
  projectId: string;
  projectStatus: OutcomeTargetProjectView["projectStatus"];
  reason: "not_reflected" | "incomplete";
};

export type OutcomeEvaluability = {
  status: OutcomeEvaluabilityStatus;
  /** 評価を妨げているTarget（設定順）。`evaluable`・`no_targets`では空。 */
  unfinishedTargets: UnfinishedOutcomeTarget[];
};

/**
 * 全Targetの還流状況からOutcomeの評価可能性を判定する。一部のProjectの完了だけでは評価可能にしない。
 * Project archiveだけを理由にTargetを除外せず、archive前に還流済みで終わったExecutionはそのまま評価の入力になる。
 * archivedのTargetに未完了が残る場合は、activeなTargetの還流待ちより優先して`replan_required`とする。
 */
export const assessOutcomeEvaluability = (targets: readonly OutcomeTargetExecution[]): OutcomeEvaluability => {
  if (targets.length === 0) return { status: "no_targets", unfinishedTargets: [] };
  const unfinishedTargets: UnfinishedOutcomeTarget[] = [];
  for (const target of targets) {
    const reason = target.execution === null ? "not_reflected" : target.execution.summary.state === "incomplete" ? "incomplete" : null;
    if (reason) unfinishedTargets.push({ projectId: target.projectId, projectStatus: target.projectStatus, reason });
  }
  if (unfinishedTargets.length === 0) return { status: "evaluable", unfinishedTargets };
  const archivedUnfinished = unfinishedTargets.some((target) => target.projectStatus === "archived");
  return { status: archivedUnfinished ? "replan_required" : "awaiting_execution", unfinishedTargets };
};
