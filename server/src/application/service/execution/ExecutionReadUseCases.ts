import { NotFoundError } from "../../error/NotFoundError.ts";
import { ValidationError } from "../../error/ValidationError.ts";
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
