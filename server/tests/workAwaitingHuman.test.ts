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

const criterion = { id: "c", position: 0, description: "Target別のStoryとEvidenceを参照できる", measurement: "Project別の保存データ", target: "越権なし" };
const storyBase = { projectId: "p", status: "active", sortOrder: 0, createdAt: 1, updatedAt: 1, outcomeId: "o1", originDecisionId: null, constraints: null, repository: null, correlationId: null };
const searchStories = [
  { ...storyBase, id: "s-criteria", title: "AのStory", description: null, successCriteria: [criterion] },
  { ...storyBase, id: "s-desc", title: "BのStory", description: "説明だけの語 alpha", successCriteria: null },
  { ...storyBase, id: "s-none", title: "CのStory", description: null, successCriteria: null, outcomeId: "o2" },
];
const searchTasks = [
  { ...base, id: "t1", title: "t1", storyId: "s-criteria", status: "doing" },
  { ...base, id: "t2", title: "t2", storyId: "s-desc", status: "todo" },
  { ...base, id: "t3", title: "t3", storyId: "s-none", status: "todo" },
];
const searchReader = { projectExists: async () => true, listStoriesOfProject: async () => ({ stories: searchStories }), listTasksOfProject: async () => ({ tasks: searchTasks }) };
const run = (query: object) => new SearchExecutionWorkUseCase(searchReader as never).execute("p", query);

test("保存済み成功条件（説明・測定・目標）でStoryと配下Taskを検索でき、説明のみ・条件なしのStoryも従来どおり探せる", async () => {
  for (const q of ["Target別のStoryとEvidence", "Project別の保存データ", "越権なし"]) {
    const stories = await run({ q });
    assert.deepEqual(stories.items.map((item) => (item as { story: { id: string } }).story.id), ["s-criteria"], q);
    assert.equal(stories.matched.tasks, 1);
    const tasks = await run({ q, view: "tasks" });
    assert.deepEqual(tasks.items.map((item) => (item as { task: { id: string } }).task.id), ["t1"], q);
  }
  assert.deepEqual((await run({ q: "alpha" })).items.map((item) => (item as { story: { id: string } }).story.id), ["s-desc"]);
  assert.equal((await run({ q: "越権なし 説明だけ" })).range.total, 0);
});

test("成功条件の検索は状態・Outcome指定と併用でき、進捗の分母は検索語で変わらない", async () => {
  const result = await run({ q: "越権なし", status: "doing", outcome: "o1" });
  assert.equal(result.range.total, 1);
  assert.deepEqual(result.scope, { stories: 2, tasks: 2, accepted: 0, canceled: 0 });
  const other = await run({ q: "越権なし", outcome: "o2" });
  assert.equal(other.range.total, 0);
  assert.deepEqual(other.scope, { stories: 1, tasks: 1, accepted: 0, canceled: 0 });
  assert.equal((await run({ q: "越権なし", status: "todo" })).range.total, 0);
});
