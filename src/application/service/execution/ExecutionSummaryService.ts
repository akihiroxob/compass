import type { Kysely } from "kysely";
import { StoryStatus } from "../../../domain/model/execution/StoryStatus.ts";
import type { Database } from "../../../infrastructure/database/schema.ts";
import { outcomeCorrelationId } from "../../../shared/outcomeCorrelation.ts";
import type {
  ExecutionStorySummary,
  ExecutionSummaryPort,
  ExecutionSummarySnapshot,
  ExecutionSummaryState,
  ExecutionTaskCounts,
} from "../../port/ExecutionSummaryPort.ts";

const emptyCounts = (): ExecutionTaskCounts => ({
  todo: 0,
  doing: 0,
  in_review: 0,
  wait_accept: 0,
  accepted: 0,
  rejected: 0,
  canceled: 0,
});

/**
 * 1 Storyの結果。Taskが無いStoryはManagerがまだ計画していないためincomplete（acceptedにしない）。
 * 進行中のTaskが1件でもあればincomplete、そうでなく未解決の差戻しがあればrejected、残りがすべてacceptedならaccepted。
 */
const storyState = (status: string, counts: ExecutionTaskCounts): ExecutionSummaryState => {
  if (status === StoryStatus.CANCELED) return "canceled";
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total === 0) return "incomplete";
  if (counts.canceled === total) return "canceled";
  if (counts.todo + counts.doing + counts.in_review + counts.wait_accept > 0) return "incomplete";
  if (counts.rejected > 0) return "rejected";
  return "accepted";
};

/** キャンセルされたStoryは結果に寄与させない。すべてキャンセルならcanceled。 */
const outcomeState = (stories: ExecutionStorySummary[]): ExecutionSummaryState => {
  const live = stories.filter((story) => story.state !== "canceled");
  if (live.length === 0) return "canceled";
  if (live.some((story) => story.state === "incomplete")) return "incomplete";
  if (live.some((story) => story.state === "rejected")) return "rejected";
  return "accepted";
};

/**
 * Execution自身のtable（story / task / change_log）だけを読み、Outcomeに相関付いたStory・Taskの結果を導出する。
 * Directionのtableは読まず、書き込みもしない。Outcomeとの対応は、Story作成時に保存した`outcome_ref`だけを使う。
 */
export class ExecutionSummaryService implements ExecutionSummaryPort {
  constructor(private readonly database: Kysely<Database>) {}

  async getOutcomeExecutionSummary(projectId: string, outcomeId: string): Promise<ExecutionSummarySnapshot | null> {
    const stories = await this.database
      .selectFrom("story")
      .select(["id", "status"])
      .where("project_id", "=", projectId)
      .where("outcome_ref", "=", outcomeId)
      .orderBy("sort_order", "asc")
      .orderBy("created_at", "asc")
      .execute();
    if (stories.length === 0) return null;

    const storyIds = stories.map((story) => story.id);
    const tasks = await this.database
      .selectFrom("task")
      .select(["id", "story_id", "status"])
      .where("project_id", "=", projectId)
      .where("story_id", "in", storyIds)
      .execute();

    const countsByStory = new Map<string, ExecutionTaskCounts>(storyIds.map((id) => [id, emptyCounts()]));
    for (const task of tasks) {
      const counts = countsByStory.get(task.story_id ?? "");
      if (counts && task.status in counts) counts[task.status] += 1;
    }
    const summaries: ExecutionStorySummary[] = stories.map((story) => {
      const taskCounts = countsByStory.get(story.id) ?? emptyCounts();
      return { storyId: story.id, status: story.status, state: storyState(story.status, taskCounts), taskCounts };
    });

    const entityIds = [...storyIds, ...tasks.map((task) => task.id)];
    const latest = await this.database
      .selectFrom("change_log")
      .select(({ fn }) => fn.max("cursor").as("cursor"))
      .where("project_id", "=", projectId)
      .where("entity_id", "in", entityIds)
      .executeTakeFirst();
    const head = await this.database
      .selectFrom("change_log")
      .select(({ fn }) => fn.max("cursor").as("cursor"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();

    return {
      outcomeId,
      correlationId: outcomeCorrelationId(outcomeId),
      state: outcomeState(summaries),
      stories: summaries,
      latestChangeCursor: Number(latest?.cursor ?? 0),
      headChangeCursor: Number(head?.cursor ?? 0),
    };
  }
}
