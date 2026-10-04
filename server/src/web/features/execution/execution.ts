import type { ProjectOperationAccess } from "../../projectAccess.ts";
import type { StatusTone } from "../../statusTone.ts";
import type {
  CriterionVerdict,
  EvaluationResult,
  ExecutionState,
  OutcomeEvaluation,
  OutcomeExecutionRecord,
} from "@compass/direction/domain";

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
/** 終端（受入済み・取消）の状態。 */
export const isSettledTask = (status: TaskStatus) => status === "accepted" || status === "canceled";
/** 状態badgeの意味。受入待ち・差戻しはHumanかAgentの対応を要し、作業中・レビュー待ちは進行中（Agentの稼働を意味しない）。 */
export const taskStatusTones: Record<TaskStatus, StatusTone> = {
  todo: "waiting",
  doing: "progress",
  in_review: "progress",
  wait_accept: "attention",
  accepted: "done",
  rejected: "attention",
  canceled: "muted",
};
/** Task行のbadge。期限切れClaimの作業中（再取得待ち）は担当中に見せず警告にする。 */
export const taskTone = (task: Pick<ExecutionTask, "status" | "reclaimable">): StatusTone => (task.reclaimable ? "warning" : taskStatusTones[task.status]);
export const storyStatusTones: Record<StoryStatus, StatusTone> = { todo: "waiting", doing: "progress", done: "done", canceled: "muted" };

export const changeTypeLabels: Record<string, string> = {
  STORY_CREATED: "Story作成",
  STORY_STARTED: "Story開始",
  STORY_COMPLETED: "Story完了",
  STORY_CANCELED: "Story取消",
  STORY_EDITED: "Story編集",
  TASK_CREATED: "Task作成",
  TASK_CLAIMED: "Claim取得",
  TASK_COMPLETED: "作業完了",
  TASK_REVIEWED: "レビュー承認",
  TASK_ACCEPTED: "受入",
  TASK_REJECTED: "差戻し",
  TASK_CANCELED: "Task取消",
  TASK_EDITED: "Task編集",
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

export type ChangeTarget = { kind: "story" | "task"; id: string; title: string | null };

/**
 * 「最近の変更」でChangeの対象を識別する。Storyの変更（`STORY_*`）は一覧に無くてもIDで出し、
 * Taskの変更は一覧にあるTaskだけを対象にする（Task詳細へのリンクに使う）。
 */
export const changeTarget = (change: Pick<ExecutionChange, "type" | "entityId">, overview: ExecutionOverview): ChangeTarget | null => {
  if (change.type.startsWith("STORY_")) {
    const story = overview.stories.find((item) => item.id === change.entityId);
    return { kind: "story", id: change.entityId, title: story?.title ?? null };
  }
  const task = overview.tasks.find((item) => item.id === change.entityId);
  return task ? { kind: "task", id: task.id, title: task.title } : null;
};

/** Project詳細のStory cardのanchor。「最近の変更」のStory変更から辿る。 */
export const storyAnchorId = (storyId: string) => `execution-story-${storyId}`;
/** Project詳細のTask行のanchor。概要の「次の行動」から「実行」viewの該当Taskへ辿る。 */
export const taskAnchorId = (taskId: string) => `execution-task-${taskId}`;

const editedFieldLabels: Record<string, string> = { title: "タイトル", description: "説明", sortOrder: "並び順" };

/**
 * 編集Change（`STORY_EDITED` / `TASK_EDITED`）の変更内容。タイトルは変更前後を出し、説明・並び順は変わったことだけを出す。
 * 編集Change以外・payloadが想定外なら`null`。
 */
export const changeEditSummary = (change: Pick<ExecutionChange, "type" | "payload">): string | null => {
  if (change.type !== "STORY_EDITED" && change.type !== "TASK_EDITED") return null;
  const { changes } = change.payload;
  if (typeof changes !== "object" || changes === null) return null;
  const parts = Object.entries(changes as Record<string, { from?: unknown; to?: unknown }>).map(([field, value]) =>
    field === "title" && typeof value?.from === "string" && typeof value?.to === "string"
      ? `タイトル「${value.from}」→「${value.to}」`
      : (editedFieldLabels[field] ?? field),
  );
  return parts.length ? parts.join("、") : null;
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

// ---- Human手動起票（Task 47）。Story・Taskの作成・編集。表示の判定だけで、拒否は常にserverが行う。 ----

export const storiesApiPath = (projectId: string, storyId?: string) => `/api/projects/${projectId}/stories${storyId ? `/${storyId}` : ""}`;
export const tasksApiPath = (projectId: string, taskId?: string) => `/api/projects/${projectId}/tasks${taskId ? `/${taskId}` : ""}`;

/** Humanが編集・Task追加できるStory。Outcome handoff（相関ID付き）はManagerが管理し、完了・取消のStoryは対象外。 */
export const isManualOpenStory = (story: Pick<ExecutionStory, "correlationId" | "status">): boolean =>
  story.correlationId === null && story.status !== "done" && story.status !== "canceled";

/** Humanが編集できるTask。handoffのTask（`taskKey`付き・handoff Story配下）と、受入済み・取消済みは対象外。 */
export const isManualEditableTask = (
  task: Pick<ExecutionTask, "taskKey" | "status">,
  story: Pick<ExecutionStory, "correlationId"> | null,
): boolean => task.taskKey === null && (story?.correlationId ?? null) === null && !isSettledTask(task.status);

/** Task起票フォームの対象Storyの選択肢（手動起票で開いているStoryだけ。順序はAPIの順）。 */
export const manualTaskStoryOptions = (stories: ExecutionStory[]): ExecutionStory[] => stories.filter(isManualOpenStory);

/** URLの`?storyId=`を初期値にする。選択肢に無いStory（handoff・完了・別Project）は無視し、未選択にする。 */
export const initialTaskStoryId = (requested: string | null, options: Pick<ExecutionStory, "id">[]): string =>
  requested !== null && options.some((story) => story.id === requested) ? requested : "";

export type ExecutionItemFormValues = { title: string; description: string };
export const executionItemFormValues = (item?: { title: string; description: string | null }): ExecutionItemFormValues => ({
  title: item?.title ?? "",
  description: item?.description ?? "",
});

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
export const evaluationResultTones: Record<EvaluationResult, StatusTone> = { achieved: "done", failed: "attention", insufficient_evidence: "warning" };
export const verdictLabels: Record<CriterionVerdict, string> = {
  met: "満たす",
  not_met: "満たさない",
  insufficient_evidence: "Evidence不足",
};
export const verdictTones: Record<CriterionVerdict, StatusTone> = { met: "done", not_met: "attention", insufficient_evidence: "warning" };

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

/** 閉ループの段のbadge。評価済みは結果に従い、未評価・未還流を達成のように見せない。 */
export const loopStageTone = (stage: LoopStage): StatusTone => {
  switch (stage.stage) {
    case "evaluated": return evaluationResultTones[stage.result];
    case "not_reflected": return "progress";
    case "not_evaluated":
    case "not_connected": return "waiting";
  }
};

// ---- Project詳細の「Claim保持中」（Task 02）。期限内のClaimを持つTaskを状態ごとにまとめ、期限切れは再取得待ちとして分ける。 ----

/** Claimを保持し得るTask状態（作業・レビュー・受入）。表示の順でもある。 */
export const claimHolderStatuses = ["doing", "in_review", "wait_accept"] as const satisfies readonly TaskStatus[];
export type ClaimHolderStatus = (typeof claimHolderStatuses)[number];
export type ClaimHolderGroup = { status: ClaimHolderStatus; tasks: (ExecutionTask & { activeClaim: NonNullable<ExecutionTask["activeClaim"]> })[] };
export type ClaimHolders = { groups: ClaimHolderGroup[]; reclaimableCount: number };

/**
 * Claim保持中のTaskの集約。`now`（取得時刻以降）で期限を過ぎたClaimは保持中に含めず、`doing`なら再取得待ちとして数える
 * （serverの`reclaimable`と同じ判定を、表示中に期限が過ぎた場合にも適用する）。グループは期限の近い順で、空のグループは省く。
 */
export const summarizeClaimHolders = (tasks: readonly ExecutionTask[], now: number): ClaimHolders => {
  const groups = claimHolderStatuses.map((status): ClaimHolderGroup => ({ status, tasks: [] }));
  let reclaimableCount = 0;
  for (const task of tasks) {
    const held = task.activeClaim !== null && task.activeClaim.expiresAt > now;
    if (!held) {
      if (task.status === "doing" && (task.reclaimable || task.activeClaim !== null)) reclaimableCount += 1;
      continue;
    }
    groups.find((group) => group.status === task.status)?.tasks.push(task as ClaimHolderGroup["tasks"][number]);
  }
  for (const group of groups) group.tasks.sort((a, b) => a.activeClaim.expiresAt - b.activeClaim.expiresAt);
  return { groups: groups.filter((group) => group.tasks.length > 0), reclaimableCount };
};

/** Claim期限の相対表示（`now`時点）。秒単位のカウントダウンはしない。 */
export const formatClaimExpiry = (expiresAt: number, now: number): string => {
  const minutes = Math.floor((expiresAt - now) / 60_000);
  if (expiresAt <= now) return "期限切れ";
  if (minutes < 1) return "あと1分未満";
  if (minutes < 60) return `あと${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `あと${hours}時間${minutes % 60}分` : `あと${hours}時間`;
};

/** 保持中のClaimで最も早い期限。表示中に期限を過ぎたら再読込を促すために使う。 */
export const earliestClaimExpiry = ({ groups }: ClaimHolders): number | null => {
  const expiries = groups.flatMap((group) => group.tasks.map((task) => task.activeClaim.expiresAt));
  return expiries.length ? Math.min(...expiries) : null;
};

/** Storyが1件も無いときの案内。起票するAgentを示し、手動起票は起票できる場合だけ案内する。archivedでは起票されない。 */
export const storyEmptyMessage = (access: ProjectOperationAccess | "loading" | "error"): string =>
  access === "archived"
    ? "Storyはありません。アーカイブ済みのため、新しいStoryは起票されません。"
    : access === "allowed"
      ? "Storyはまだありません。Outcomeが確定するとManagerが起票し、ここに表示されます。Outcomeに依らない作業は「Storyを起票」から手動で起票できます。"
      : "Storyはまだありません。Outcomeが確定するとManagerが起票し、ここに表示されます。";
