import { NotFoundError, ValidationError } from "@compass/shared";
import { TaskStatus } from "../domain/TaskStatus.ts";
import type { TaskCoordinationService } from "./TaskCoordinationService.ts";

/**
 * Human向けの読取だけが使うExecution serviceの範囲。Role Grantを検査しない読取メソッドに限る。
 * Execution側に置くため、DirectionのRepositoryは使わず、Projectの存在は共有の根（project）をExecution serviceが読む。
 */
type ExecutionReader = Pick<
  TaskCoordinationService,
  "projectExists" | "listStoriesOfProject" | "listTasksOfProject" | "getTaskDetailOfProject" | "listRecentChangesOfProject"
>;

const assertProjectExists = async (execution: ExecutionReader, projectId: string) => {
  if (!(await execution.projectExists(projectId))) {
    throw new NotFoundError(`Project ${projectId} was not found`);
  }
};

/**
 * ProjectのExecution Story・Task一覧（Human向け読取、Task 45）。`outcomeId`を渡すと、そのOutcomeを参照するStoryと
 * 配下のTaskだけを返す。認可は入口（Membership）が行い、Story・Taskの規則はExecution serviceに1つだけ置く。
 */
export class ListExecutionUseCase {
  constructor(private readonly execution: ExecutionReader) {}

  async execute(projectId: string, filter: { outcomeId?: string } = {}) {
    await assertProjectExists(this.execution, projectId);
    const [{ stories }, { summary, tasks }] = await Promise.all([
      this.execution.listStoriesOfProject(projectId),
      this.execution.listTasksOfProject(projectId),
    ]);
    if (filter.outcomeId === undefined) return { stories, tasks, summary };
    const selected = stories.filter((story) => story.outcomeId === filter.outcomeId);
    const storyIds = new Set(selected.map((story) => story.id));
    return { stories: selected, tasks: tasks.filter((task) => task.storyId !== null && storyIds.has(task.storyId)) };
  }
}

/** Task詳細（説明・状態・Claim・Comment・差戻し理由・関連Change）。別ProjectのTask IDは404。 */
export class GetExecutionTaskUseCase {
  constructor(private readonly execution: ExecutionReader) {}

  async execute(projectId: string, taskId: string) {
    await assertProjectExists(this.execution, projectId);
    const detail = await this.execution.getTaskDetailOfProject(projectId, taskId);
    if (!detail) throw new NotFoundError(`Task ${taskId} was not found in Project ${projectId}`);
    return detail;
  }
}

export const maximumChangePageSize = 100;
const defaultChangePageSize = 50;

/**
 * Projectの「最近の変更」（Execution Change Log）。新しい順で、`beforeCursor`でさらに古い変更を辿る。
 * MCP `list_changes`（古い順・`afterCursor`）と同じChange Logを、Human向けの閲覧順で返す。
 */
export class ListRecentExecutionChangesUseCase {
  constructor(private readonly execution: ExecutionReader) {}

  async execute(projectId: string, query: { beforeCursor?: number; limit?: number } = {}) {
    const issues: { path: string; message: string }[] = [];
    const { beforeCursor, limit = defaultChangePageSize } = query;
    if (beforeCursor !== undefined && !(Number.isSafeInteger(beforeCursor) && beforeCursor > 0)) {
      issues.push({ path: "beforeCursor", message: "beforeCursor must be a positive integer" });
    }
    if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= maximumChangePageSize)) {
      issues.push({ path: "limit", message: `limit must be an integer between 1 and ${maximumChangePageSize}` });
    }
    if (issues.length) throw new ValidationError("Change query is invalid", issues);
    await assertProjectExists(this.execution, projectId);
    return this.execution.listRecentChangesOfProject(projectId, beforeCursor ?? null, limit);
  }
}

// ---- 開発詳細の検索・ページング（UI-W1）。Project内の全Story・Taskを、サーバー側で絞り込んでページ単位に返す。 ----

export const workViews = ["stories", "tasks"] as const;
export type WorkView = (typeof workViews)[number];
/** 1ページの件数。Story表示はStory（とStoryに属さないTask）、Task一覧はTaskを数える。 */
export const workPageSizes: Record<WorkView, number> = { stories: 10, tasks: 20 };
/** Outcomeに紐付かないStory（手動起票）と、Storyに属さないTaskだけを対象にする`outcome`の値。 */
export const unsetOutcomeFilter = "none";
/** Humanの受入・差戻しを待つTask（レビュー待ち・受入待ちで、期限内のClaimが無い）を表す`status`の値。 */
export const awaitingHumanStatus = "awaiting_human";
export const maximumWorkQueryLength = 200;

export type SearchWorkQuery = {
  view?: string;
  q?: string;
  status?: string;
  outcome?: string;
  storyId?: string;
  page?: number;
};

type WorkTaskView = Awaited<ReturnType<ExecutionReader["listTasksOfProject"]>>["tasks"][number];
type WorkStoryView = Awaited<ReturnType<ExecutionReader["listStoriesOfProject"]>>["stories"][number];
type WorkTaskContext = { id: string; title: string; outcomeId: string | null };
export type WorkItem =
  | { kind: "story"; story: WorkStoryView; tasks: WorkTaskView[]; taskCount: number; acceptedCount: number }
  | { kind: "task"; task: WorkTaskView; story: WorkTaskContext | null };

const taskStatuses = Object.values(TaskStatus) as string[];
const normalize = (value: string) => value.toLocaleLowerCase();

/**
 * ProjectのStory・Task（Human向け読取）。検索・状態・Outcomeの絞り込みと、ページ取得をサーバーで行う。
 * 進捗（`scope`）はOutcome・Storyの範囲で数え、検索語と状態では分母を変えない。該当件数（`matched`）は検索語・状態で絞った件数。
 * 検索語（空白区切りはAND）はStoryの題名・説明（受入条件）とTaskの題名・説明・差戻し理由を対象にする。Storyに当たればそのStoryの全Task、Taskに当たればそのTaskが該当する。
 */
export class SearchExecutionWorkUseCase {
  constructor(private readonly execution: ExecutionReader) {}

  async execute(projectId: string, query: SearchWorkQuery = {}) {
    const issues: { path: string; message: string }[] = [];
    const view = (query.view ?? "stories") as WorkView;
    if (!workViews.includes(view)) issues.push({ path: "view", message: `view must be one of ${workViews.join(", ")}` });
    const text = (query.q ?? "").trim();
    if (text.length > maximumWorkQueryLength) issues.push({ path: "q", message: `q must be at most ${maximumWorkQueryLength} characters` });
    const status = query.status;
    if (status !== undefined && status !== awaitingHumanStatus && !taskStatuses.includes(status)) {
      issues.push({ path: "status", message: `status must be one of ${[...taskStatuses, awaitingHumanStatus].join(", ")}` });
    }
    const requestedPage = query.page ?? 1;
    if (!(Number.isSafeInteger(requestedPage) && requestedPage >= 1)) issues.push({ path: "page", message: "page must be a positive integer" });
    if (issues.length) throw new ValidationError("Work query is invalid", issues);
    await assertProjectExists(this.execution, projectId);

    const [{ stories }, { tasks }] = await Promise.all([
      this.execution.listStoriesOfProject(projectId),
      this.execution.listTasksOfProject(projectId),
    ]);

    // 範囲: Story指定 > Outcome指定。範囲は進捗の分母で、検索語・状態では変えない。
    const inScopeStories = stories.filter((story) => {
      if (query.storyId !== undefined) return story.id === query.storyId;
      if (query.outcome === undefined) return true;
      return query.outcome === unsetOutcomeFilter ? story.outcomeId === null : story.outcomeId === query.outcome;
    });
    const scopedIds = new Set(inScopeStories.map((story) => story.id));
    const includeUnassigned = query.storyId === undefined && (query.outcome === undefined || query.outcome === unsetOutcomeFilter);
    const storyById = new Map(stories.map((story) => [story.id, story]));
    const inScopeTasks = tasks.filter((task) => (task.storyId !== null && storyById.has(task.storyId) ? scopedIds.has(task.storyId) : includeUnassigned));

    // 空白区切りの語はすべて含むこと（AND）。Storyの題名・説明（受入条件）は、そのStoryのTaskの検索対象にも含める。
    const words = normalize(text).split(/\s+/).filter(Boolean);
    const matchesWords = (haystack: string) => words.every((word) => haystack.includes(word));
    const storyText = (story: WorkStoryView | undefined) => (story ? normalize(`${story.title}\n${story.description ?? ""}`) : "");
    const statusMatches = (task: WorkTaskView) =>
      status === undefined ||
      (status === awaitingHumanStatus
        ? (task.status === TaskStatus.IN_REVIEW || task.status === TaskStatus.WAIT_ACCEPT) && task.activeClaim === null
        : task.status === status);
    const taskMatches = (task: WorkTaskView) =>
      statusMatches(task) &&
      matchesWords(`${storyText(task.storyId === null ? undefined : storyById.get(task.storyId))}\n${normalize(`${task.title}\n${task.description ?? ""}\n${task.rejectReason ?? ""}`)}`);

    const tasksByStory = new Map<string, WorkTaskView[]>();
    for (const task of inScopeTasks) {
      if (task.storyId === null || !storyById.has(task.storyId)) continue;
      tasksByStory.set(task.storyId, [...(tasksByStory.get(task.storyId) ?? []), task]);
    }
    const unassigned = inScopeTasks.filter((task) => task.storyId === null || !storyById.has(task.storyId));

    const storyItems: WorkItem[] = [];
    for (const story of inScopeStories) {
      const own = tasksByStory.get(story.id) ?? [];
      const matched = own.filter(taskMatches);
      // Taskの無いStoryは、状態を絞らないときだけ題名・説明で探せる。
      if (matched.length === 0 && !(own.length === 0 && status === undefined && matchesWords(storyText(story)))) continue;
      storyItems.push({ kind: "story", story, tasks: matched, taskCount: own.length, acceptedCount: own.filter((task) => task.status === TaskStatus.ACCEPTED).length });
    }
    const unassignedItems: WorkItem[] = unassigned.filter(taskMatches).map((task) => ({ kind: "task", task, story: null }));
    const contextOf = (task: WorkTaskView): WorkTaskContext | null => {
      const story = task.storyId === null ? undefined : storyById.get(task.storyId);
      return story ? { id: story.id, title: story.title, outcomeId: story.outcomeId } : null;
    };
    const taskItems: WorkItem[] = inScopeTasks.filter(taskMatches).map((task) => ({ kind: "task", task, story: contextOf(task) }));

    const all = view === "stories" ? [...storyItems, ...unassignedItems] : taskItems;
    const pageSize = workPageSizes[view];
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const from = all.length === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, all.length);
    return {
      view,
      page,
      pageSize,
      totalPages,
      /** 現在ページの表示範囲（1始まり、該当0件なら0〜0）と該当件数。 */
      range: { from, to, total: all.length },
      /** 検索語・状態で絞った該当件数。Story表示のStoryは該当Taskを持つStory（Taskの無いStoryを含む）。 */
      matched: {
        stories: storyItems.length,
        tasks: taskItems.length,
      },
      /** 進捗の範囲（Outcome・Story指定まで）。検索語・状態で絞らない。進捗は受入済み÷（tasks − canceled）で、Outcome一覧と同じ規則。 */
      scope: {
        stories: inScopeStories.length,
        tasks: inScopeTasks.length,
        accepted: inScopeTasks.filter((task) => task.status === TaskStatus.ACCEPTED).length,
        canceled: inScopeTasks.filter((task) => task.status === TaskStatus.CANCELED).length,
      },
      items: all.slice(from === 0 ? 0 : from - 1, to),
    };
  }
}
