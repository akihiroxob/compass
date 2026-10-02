import { StoryStatus } from "../domain/StoryStatus.ts";
import type { WorkStore } from "./port/WorkStore.ts";
import {
  type ExecutionStorySummary,
  type ExecutionSummaryPort,
  type ExecutionSummarySnapshot,
  type ExecutionSummaryState,
  type ExecutionSummaryTaskCounts,
  outcomeCorrelationId,
} from "@compass/direction";

const emptyCounts = (): ExecutionSummaryTaskCounts => ({
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
const storyState = (status: string, counts: ExecutionSummaryTaskCounts): ExecutionSummaryState => {
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
 * Work自身のrecord（Story / Task / Change Log）だけをstore経由で読み、Outcomeに相関付いたStory・Taskの結果を導出する。
 * Directionのtableは読まず、書き込みもしない。Outcomeとの対応は、Story作成時に保存した`outcome_ref`だけを使う。
 */
export class ExecutionSummaryService implements ExecutionSummaryPort {
  constructor(private readonly store: WorkStore) {}

  async getOutcomeExecutionSummary(projectId: string, outcomeId: string): Promise<ExecutionSummarySnapshot | null> {
    const stories = await this.store.listStoriesByOutcome(projectId, outcomeId);
    if (stories.length === 0) return null;

    const storyIds = stories.map((story) => story.id);
    const tasks = await this.store.listTasksOfStories(projectId, storyIds);

    const countsByStory = new Map<string, ExecutionSummaryTaskCounts>(storyIds.map((id) => [id, emptyCounts()]));
    for (const task of tasks) {
      const counts = countsByStory.get(task.story_id ?? "");
      if (counts && task.status in counts) counts[task.status] += 1;
    }
    const summaries: ExecutionStorySummary[] = stories.map((story) => {
      const taskCounts = countsByStory.get(story.id) ?? emptyCounts();
      return { storyId: story.id, status: story.status, state: storyState(story.status, taskCounts), taskCounts };
    });

    const entityIds = [...storyIds, ...tasks.map((task) => task.id)];
    const latestChangeCursor = await this.store.maxChangeCursor(projectId, entityIds);
    const headChangeCursor = await this.store.maxChangeCursor(projectId);

    return {
      outcomeId,
      correlationId: outcomeCorrelationId(outcomeId),
      state: outcomeState(summaries),
      stories: summaries,
      latestChangeCursor,
      headChangeCursor,
    };
  }
}
