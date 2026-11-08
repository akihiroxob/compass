import type { ExecutionStory, ExecutionTask, TaskStatus } from "./execution.ts";
import { availableTaskOperations, taskStatusLabels } from "./execution.ts";

// ---- 開発詳細（Project Work）の検索・ページング（UI-W1）。Web API `GET /api/projects/:projectId/work`の条件・応答と、URLの条件。 ----
// 検索・絞り込み・ページ取得はserverが行う。ここはURLの条件と表示用の変換だけを持ち、全件をbrowserに持たない。

export const workModes = ["stories", "tasks"] as const;
export type WorkMode = (typeof workModes)[number];
export const workModeLabels: Record<WorkMode, string> = { stories: "Storyごと", tasks: "Task一覧" };

export const awaitingHumanStatus = "awaiting_human";
export type WorkStatus = "all" | typeof awaitingHumanStatus | TaskStatus;
export const workStatuses: readonly WorkStatus[] = ["all", awaitingHumanStatus, "todo", "doing", "in_review", "wait_accept", "accepted", "rejected", "canceled"];
export const workStatusLabel = (status: WorkStatus): string =>
  status === "all" ? "すべて" : status === awaitingHumanStatus ? "Humanの判断待ち" : taskStatusLabels[status];

/** Outcome絞り込みの特別な値。`all`はすべてのOutcome（未設定を含む）、`none`はOutcome未設定のStory・Task。 */
export const allOutcomes = "all";
export const unsetOutcome = "none";
export const maximumWorkQueryLength = 200;

export type WorkQuery = { mode: WorkMode; q: string; status: WorkStatus; outcome: string; story: string | null; page: number };

export const parseWorkQuery = (params: URLSearchParams): WorkQuery => {
  const page = Number(params.get("page"));
  const status = params.get("status");
  return {
    mode: workModes.find((mode) => mode === params.get("mode")) ?? "stories",
    q: (params.get("q") ?? "").slice(0, maximumWorkQueryLength),
    status: workStatuses.find((item) => item === status) ?? "all",
    outcome: params.get("outcome") || allOutcomes,
    story: params.get("story") || null,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
};

/** 既定値のqueryは付けない。条件（検索・状態・Outcome・Story・表示形式）を変えたらページは1へ戻し、`view`等の他のqueryは残す。 */
export const workSearch = (current: URLSearchParams, patch: Partial<WorkQuery>): string => {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string | null) => { if (value === null || value === "") next.delete(key); else next.set(key, value); };
  if (patch.mode !== undefined) set("mode", patch.mode === "stories" ? null : patch.mode);
  if (patch.q !== undefined) set("q", patch.q.trim());
  if (patch.status !== undefined) set("status", patch.status === "all" ? null : patch.status);
  if (patch.outcome !== undefined) set("outcome", patch.outcome === allOutcomes ? null : patch.outcome);
  if (patch.story !== undefined) set("story", patch.story);
  const conditionChanged = ["mode", "q", "status", "outcome", "story"].some((key) => key in patch);
  if (patch.page !== undefined) set("page", patch.page > 1 ? String(patch.page) : null);
  else if (conditionChanged) next.delete("page");
  const search = next.toString();
  return search ? `?${search}` : "";
};

/** 条件（表示形式とページを除く）が既定か。 */
export const hasWorkCondition = (query: WorkQuery): boolean =>
  query.q !== "" || query.status !== "all" || query.outcome !== allOutcomes || query.story !== null;

export const clearedWorkSearch = (current: URLSearchParams): string => workSearch(current, { q: "", status: "all", outcome: allOutcomes, story: null });

export const workApiPath = (projectId: string, query: WorkQuery): string => {
  const params = new URLSearchParams({ view: query.mode });
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.status !== "all") params.set("status", query.status);
  if (query.outcome !== allOutcomes) params.set("outcome", query.outcome);
  if (query.story) params.set("storyId", query.story);
  if (query.page > 1) params.set("page", String(query.page));
  return `/api/projects/${projectId}/work?${params.toString()}`;
};

export type WorkTaskContext = { id: string; title: string; outcomeId: string | null };
export type WorkStoryItem = { kind: "story"; story: ExecutionStory; tasks: ExecutionTask[]; taskCount: number; acceptedCount: number };
export type WorkTaskItem = { kind: "task"; task: ExecutionTask; story: WorkTaskContext | null };
export type WorkItem = WorkStoryItem | WorkTaskItem;
export type WorkPage = {
  view: WorkMode;
  page: number;
  pageSize: number;
  totalPages: number;
  range: { from: number; to: number; total: number };
  matched: { stories: number; tasks: number };
  scope: { stories: number; tasks: number; accepted: number; canceled: number };
  items: WorkItem[];
};

/** 進捗の分母は取消を除いたTask（Outcome一覧の規則と同じ）。 */
export const progressDenominator = ({ tasks, canceled }: Pick<WorkPage["scope"], "tasks" | "canceled">): number => tasks - canceled;
/** Task進捗率（受入済み÷分母）。分母が0なら0%にせず`null`（Task未起票または全て取消）。検索・状態で絞った件数では変わらない。 */
export const progressPercent = (scope: Pick<WorkPage["scope"], "accepted" | "tasks" | "canceled">): number | null => {
  const denominator = progressDenominator(scope);
  return denominator <= 0 ? null : Math.floor((scope.accepted / denominator) * 100);
};

/**
 * Taskが止まっている理由と、次に動く側。Agentの稼働は推測せず、Taskの状態・差戻し理由・相談待ち・Claimの有無だけから判断する。
 * 動く必要が無い（作業中・未着手・終端）は`null`。
 */
export type TaskBlocker = { side: "human" | "agent"; reason: string };
/** 相談待ちの原因から、止めている担当側と理由。Agentの応答待ち・継続確認待ち・再開はHumanの操作を要しない。 */
export const consultationBlocker = (cause: NonNullable<ExecutionTask["consultationWait"]>["cause"]): TaskBlocker => (({
  human: { side: "human", reason: "Humanへの相談の回答待ち" },
  agent: { side: "agent", reason: "相談へのAgentの応答待ち" },
  continuation: { side: "agent", reason: "相談の結論後、Managerの継続確認待ち" },
  ready: { side: "agent", reason: "相談の結論を受けて再開待ち" },
  resuming: { side: "agent", reason: "相談の結論を受けて再開中" },
}) satisfies Record<string, TaskBlocker>)[cause];
export const taskBlocker = (task: Pick<ExecutionTask, "status" | "activeClaim" | "rejectReason" | "consultationWait" | "reclaimable">): TaskBlocker | null => {
  if (task.consultationWait) return consultationBlocker(task.consultationWait.cause);
  if (task.status === "rejected") return { side: "agent", reason: task.rejectReason?.trim() ? `差戻し: ${task.rejectReason}` : "差戻し（理由は記録されていません）" };
  if (availableTaskOperations(task).includes("accept")) return { side: "human", reason: task.status === "wait_accept" ? "受入の判断待ち" : "レビューの確認待ち" };
  if (task.reclaimable) return { side: "agent", reason: "Claimの期限切れ（再取得待ち）" };
  return null;
};
export const blockerSideLabels: Record<TaskBlocker["side"], string> = { human: "対応待ち", agent: "Agentが対処" };

/** Task詳細から開発詳細へ戻る先（Link stateで渡す。絞り込み条件とページを残す）。 */
export const workBackState = (projectId: string, search: string) => ({ workBack: `/projects/${projectId}${search}` });
export const readWorkBack = (state: unknown, projectId: string): string => {
  const back = typeof state === "object" && state !== null && "workBack" in state ? (state as { workBack: unknown }).workBack : null;
  const prefix = `/projects/${projectId}?`;
  return typeof back === "string" && back.startsWith(prefix) ? back : `/projects/${projectId}?view=work`;
};

/** Outcome由来Storyが作成時に保持する成功条件を位置順で返す。手動Story・条件なしは空。 */
export const storyCriteria = (story: Pick<ExecutionStory, "successCriteria">): NonNullable<ExecutionStory["successCriteria"]> =>
  [...(story.successCriteria ?? [])].sort((a, b) => a.position - b.position);
