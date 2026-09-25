import type { EvaluationResult, CriterionVerdict, OutcomeEvaluation } from "../../../domain/model/OutcomeEvaluation.ts";
import type { ExecutionState, OutcomeExecutionRecord } from "../../../domain/model/OutcomeExecution.ts";

// ---- Execution閲覧（Task 45）。Web API（`/api/projects/:projectId/execution`・`tasks/:taskId`・`changes`）の応答の型と表示用の変換。 ----

export type StoryStatus = "todo" | "doing" | "done" | "canceled";
export type TaskStatus = "todo" | "doing" | "in_review" | "wait_accept" | "accepted" | "rejected" | "canceled";

export type ExecutionStory = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: StoryStatus;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  outcomeId: string | null;
  correlationId: string | null;
};

export type ExecutionTask = {
  id: string;
  projectId: string;
  storyId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  rejectReason: string | null;
  createdAt: number;
  updatedAt: number;
  taskKey: string | null;
  /** 期限内のClaimだけ。期限切れのClaimは`null`で、`reclaimable`が立つ。 */
  activeClaim: { claimId: string; principalId: string; expiresAt: number } | null;
  reclaimable: boolean;
};

export type ExecutionChange = {
  cursor: number;
  type: string;
  entityId: string;
  principalId: string;
  claimId: string | null;
  payload: Record<string, unknown>;
  occurredAt: number;
  outcomeId?: string;
  correlationId?: string;
};

export type TaskComment = { id: string; body: string; principalId: string; claimId: string | null; createdAt: number };

export type ExecutionOverview = { stories: ExecutionStory[]; tasks: ExecutionTask[] };
export type TaskDetail = { task: ExecutionTask; story: ExecutionStory | null; comments: TaskComment[]; changes: ExecutionChange[] };
export type ChangePage = { changes: ExecutionChange[]; nextCursor: number | null };

export const executionPath = (projectId: string, outcomeId?: string) =>
  `/api/projects/${projectId}/execution${outcomeId ? `?outcomeId=${encodeURIComponent(outcomeId)}` : ""}`;
export const taskDetailApiPath = (projectId: string, taskId: string) => `/api/projects/${projectId}/tasks/${taskId}`;
export const changesPath = (projectId: string, beforeCursor: number | null = null, limit = 20) =>
  `/api/projects/${projectId}/changes?limit=${limit}${beforeCursor === null ? "" : `&beforeCursor=${beforeCursor}`}`;
export const evaluationsPath = (projectId: string, outcomeId: string) =>
  `/api/projects/${projectId}/outcomes/${outcomeId}/evaluations`;
export const executionSummaryPath = (projectId: string, outcomeId: string) =>
  `/api/projects/${projectId}/outcomes/${outcomeId}/execution-summary`;

export const storyStatusLabels: Record<StoryStatus, string> = { todo: "未着手", doing: "進行中", done: "完了", canceled: "取消" };
export const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "未着手",
  doing: "作業中",
  in_review: "レビュー待ち",
  wait_accept: "受入待ち",
  accepted: "受入済み",
  rejected: "差戻し",
  canceled: "取消",
};
/** 終端・完了側の状態は控えめのbadgeで出す。 */
export const isSettledTask = (status: TaskStatus) => status === "accepted" || status === "canceled";

export const changeTypeLabels: Record<string, string> = {
  STORY_CREATED: "Story作成",
  STORY_STARTED: "Story開始",
  STORY_COMPLETED: "Story完了",
  STORY_CANCELED: "Story取消",
  TASK_CREATED: "Task作成",
  TASK_CLAIMED: "Claim取得",
  TASK_COMPLETED: "作業完了",
  TASK_REVIEWED: "レビュー承認",
  TASK_ACCEPTED: "受入",
  TASK_REJECTED: "差戻し",
  TASK_CANCELED: "Task取消",
  CLAIM_RELEASED: "Claim解放",
  CLAIM_EXPIRED: "Claim期限切れ",
};
export const changeTypeLabel = (type: string) => changeTypeLabels[type] ?? type;

export const formatTime = (value: number) => new Date(value).toLocaleString("ja-JP");

/** Claimの表示。期限切れ（再取得可能）と、Claim無しを区別する。 */
export const describeClaim = (task: Pick<ExecutionTask, "activeClaim" | "reclaimable">): string =>
  task.activeClaim
    ? `担当 ${task.activeClaim.principalId}（期限 ${formatTime(task.activeClaim.expiresAt)}）`
    : task.reclaimable
      ? "Claimの期限切れ（再取得可能）"
      : "担当なし";

export type StoryGroup = { story: ExecutionStory; tasks: ExecutionTask[] };

/** TaskをStoryごとにまとめる。Storyに属さないTaskは`unassigned`へ分ける（Storyの順序・Taskの順序はAPIの順のまま）。 */
export const groupTasksByStory = ({ stories, tasks }: ExecutionOverview): { groups: StoryGroup[]; unassigned: ExecutionTask[] } => {
  const byStory = new Map(stories.map((story) => [story.id, [] as ExecutionTask[]]));
  const unassigned: ExecutionTask[] = [];
  for (const task of tasks) {
    const bucket = task.storyId === null ? undefined : byStory.get(task.storyId);
    if (bucket) bucket.push(task);
    else unassigned.push(task);
  }
  return { groups: stories.map((story) => ({ story, tasks: byStory.get(story.id) ?? [] })), unassigned };
};

/** 「さらに古い変更」の追加読込。同じcursorを二重に出さない（読込中の再読込・連打）。 */
export const appendChangePage = (current: ExecutionChange[], page: ExecutionChange[]): ExecutionChange[] => {
  const seen = new Set(current.map((change) => change.cursor));
  return [...current, ...page.filter((change) => !seen.has(change.cursor))];
};

/** Changeのpayloadから、表示する補足（差戻し・取消・解放の理由）を取り出す。 */
export const changeNote = (change: Pick<ExecutionChange, "payload">): string | null => {
  const { reason } = change.payload;
  return typeof reason === "string" && reason.trim() ? reason : null;
};

// ---- Human介入（Task 46）。受入・差戻し・取消・Comment。表示の判定だけで、拒否は常にserverが行う。 ----

export type TaskOperation = "accept" | "reject" | "cancel";

export const taskOperationPath = (projectId: string, taskId: string, operation: TaskOperation | "comments") =>
  `/api/projects/${projectId}/tasks/${taskId}/${operation}`;

/**
 * Taskの状態から出す介入の導線。受入・差戻しは`in_review` / `wait_accept`でClaim（期限内）が無いときだけ
 * （AgentのreviewやManagerの受入と競合させない）、取消は`todo` / `doing`（Agent Claimは同時に解放される）。
 */
export const availableTaskOperations = (task: Pick<ExecutionTask, "status" | "activeClaim">): TaskOperation[] => {
  if (task.status === "in_review" || task.status === "wait_accept") return task.activeClaim ? [] : ["accept", "reject"];
  if (task.status === "todo" || task.status === "doing") return ["cancel"];
  return [];
};

export const taskOperationNotices: Record<TaskOperation | "comment", string> = {
  accept: "Taskを受け入れました。",
  reject: "Taskを差し戻しました。",
  cancel: "Taskを取り消しました。",
  comment: "Commentを追加しました。",
};

const humanPrincipalPrefix = "human:";

/**
 * Change・Commentの`principalId`の表示。Human operator（`human:{humanUserId}`）はMemberの表示名（取得できなければIDの先頭）で出し、
 * Agent Principalはそのまま出す。
 */
export const describePrincipal = (principalId: string, humanNames: ReadonlyMap<string, string> = new Map()): string => {
  if (!principalId.startsWith(humanPrincipalPrefix)) return principalId;
  const humanUserId = principalId.slice(humanPrincipalPrefix.length);
  return `Human ${humanNames.get(humanUserId) ?? humanUserId.slice(0, 8)}`;
};

// ---- Outcome詳細の閉ループ表示。Executionの進捗・Summary・Evidence・Evaluation・Decisionを、状態を推測せずに区別する。 ----

export type { EvaluationResult, CriterionVerdict, OutcomeEvaluation, ExecutionState, OutcomeExecutionRecord };

export const executionStateLabels: Record<ExecutionState, string> = {
  accepted: "受入済み",
  rejected: "差戻し",
  canceled: "取消",
  incomplete: "未完了",
};
export const evaluationResultLabels: Record<EvaluationResult, string> = {
  achieved: "達成",
  failed: "未達成",
  insufficient_evidence: "Evidence不足",
};
export const verdictLabels: Record<CriterionVerdict, string> = {
  met: "満たす",
  not_met: "満たさない",
  insufficient_evidence: "Evidence不足",
};

export type LoopStage =
  | { stage: "not_connected"; label: string }
  | { stage: "not_reflected"; label: string }
  | { stage: "not_evaluated"; label: string }
  | { stage: "evaluated"; label: string; result: EvaluationResult };

/**
 * Outcomeの閉ループの現在地。未接続（Story無し）・未還流・未評価を成功扱いせず区別し、評価済みなら最新の総合結果を出す。
 * Executionが`accepted`でも、Evaluationが無ければ達成とは表示しない。
 */
export const outcomeLoopStage = (input: { storyCount: number; record: OutcomeExecutionRecord | null; evaluations: readonly OutcomeEvaluation[] }): LoopStage => {
  const latest = input.evaluations[0];
  if (latest) return { stage: "evaluated", label: `評価済み: ${evaluationResultLabels[latest.result]}`, result: latest.result };
  if (input.record) return { stage: "not_evaluated", label: "未評価（Executionの結果は還流済み）" };
  if (input.storyCount > 0) return { stage: "not_reflected", label: "Execution中（結果は未還流）" };
  return { stage: "not_connected", label: "Execution未接続（Storyがありません）" };
};
