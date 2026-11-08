import assert from "node:assert/strict";
import test from "node:test";
import { SearchExecutionWorkUseCase } from "@compass/work";

const base = { projectId: "p", storyId: null, description: null, rejectReason: null, createdAt: 1, updatedAt: 1, taskKey: null, activeClaim: null, reclaimable: false, consultationWait: null };
const wait = (cause: string, phase: string) => ({ state: "waiting", phase, consultations: [], failureReason: null, cause });
const tasks = [
  { ...base, id: "plain-review", title: "plain-review", status: "in_review" },
  { ...base, id: "human-review", title: "human-review", status: "in_review", consultationWait: wait("human", "review") },
  { ...base, id: "agent-review", title: "agent-review", status: "in_review", consultationWait: wait("agent", "review") },
  { ...base, id: "agent-accept", title: "agent-accept", status: "wait_accept", consultationWait: wait("agent", "acceptance") },
  { ...base, id: "human-work", title: "human-work", status: "doing", consultationWait: wait("human", "work") },
];

test("Humanの対応待ち絞り込みは、相談待ちを原因で分け、Agent待ちの相談をレビュー・受入待ちに含めない", async () => {
  const reader = { projectExists: async () => true, listStoriesOfProject: async () => ({ stories: [] }), listTasksOfProject: async () => ({ tasks }) };
  const result = await new SearchExecutionWorkUseCase(reader as never).execute("p", { view: "tasks", status: "awaiting_human" });
  assert.deepEqual(result.items.map((item) => (item as { task: { id: string } }).task.id).sort(), ["human-review", "human-work", "plain-review"]);
});
