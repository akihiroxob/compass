import { intentPath, outcomePath, workspaceOutcomePath, workspacePath } from "../../paths.ts";
import type { Outcome } from "./outcome.ts";
// テストからも読み込むため、JSXを含まない純関数だけを置く。

/** 画面の配置ごとの戻り先・保存後の行き先。Project配下はIntent・Outcome詳細、Workspace配下はWorkspaceのOutcome詳細。 */
export type Placement = { back: { to: string; label: string }; savedTo: (outcome: Outcome) => string; detailTo: string; conflictTo: { to: string; label: string }; state?: unknown };

export const projectPlacement = (projectId: string, intentId: string, outcomeId?: string): Placement => ({
  back: outcomeId ? { to: outcomePath(projectId, intentId, outcomeId), label: "← Outcome詳細" } : { to: intentPath(projectId, intentId), label: "← Intent詳細" },
  savedTo: (outcome) => outcomePath(projectId, intentId, outcome.id),
  detailTo: `/projects/${projectId}`,
  conflictTo: outcomeId ? { to: outcomePath(projectId, intentId, outcomeId), label: "最新のOutcomeを開く →" } : { to: intentPath(projectId, intentId), label: "Intentを開く →" },
});

/** Workspace配下の配置。`state`（Outcome一覧の絞り込み条件）は戻る・キャンセル・保存後の遷移へ引き継ぐ。 */
export const workspacePlacement = (workspaceId: string, intentId: string, outcomeId: string | undefined, state: unknown): Placement => {
  const direction = workspacePath(workspaceId, "direction");
  return {
    state,
    back: outcomeId ? { to: workspaceOutcomePath(workspaceId, intentId, outcomeId), label: "← Outcome詳細" } : { to: direction, label: "← Outcome" },
    savedTo: (outcome) => workspaceOutcomePath(workspaceId, intentId, outcome.id),
    detailTo: direction,
    conflictTo: outcomeId ? { to: workspaceOutcomePath(workspaceId, intentId, outcomeId), label: "最新のOutcomeを開く →" } : { to: direction, label: "Outcomeの一覧を開く →" },
  };
};
