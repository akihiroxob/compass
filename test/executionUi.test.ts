import assert from "node:assert/strict";
import test from "node:test";
import {
  availableTaskOperations,
  describePrincipal,
  taskOperationPath,
  appendChangePage,
  changeEditSummary,
  changeNote,
  changeTarget,
  changesPath,
  changeTypeLabel,
  describeClaim,
  executionPath,
  groupTasksByStory,
  initialTaskStoryId,
  isManualEditableTask,
  isManualOpenStory,
  manualTaskStoryOptions,
  storiesApiPath,
  tasksApiPath,
  storyAnchorId,
  outcomeLoopStage,
  type ExecutionChange,
  type ExecutionStory,
  type ExecutionTask,
  type OutcomeEvaluation,
  type OutcomeExecutionRecord,
} from "../src/frontend/features/execution/execution.ts";
import { storyCreatePath, storyEditPath, taskCreatePath, taskEditPath, taskPath } from "../src/frontend/paths.ts";

/** Execution閲覧UI（Task 45）の表示用の変換。画面の描画・実ブラウザ確認はTaskの作業コメントに記録する。 */

const story = (id: string, overrides: Partial<ExecutionStory> = {}): ExecutionStory => ({
  id, projectId: "p1", title: id, description: null, status: "todo", sortOrder: 0, createdAt: 0, updatedAt: 0, outcomeId: null, correlationId: null, ...overrides,
});
const task = (id: string, storyId: string | null, overrides: Partial<ExecutionTask> = {}): ExecutionTask => ({
  id, projectId: "p1", storyId, title: id, description: null, status: "todo", rejectReason: null, createdAt: 0, updatedAt: 0, taskKey: null, activeClaim: null, reclaimable: false, ...overrides,
});
const change = (cursor: number, payload: Record<string, unknown> = {}): ExecutionChange => ({
  cursor, type: "TASK_CREATED", entityId: "t1", principalId: "mgr", claimId: null, payload, occurredAt: 0,
});

test("TaskをAPIの順のままStoryごとにまとめ、Storyに属さないTask・未知のStoryのTaskを分ける", () => {
  const { groups, unassigned } = groupTasksByStory({
    stories: [story("s2"), story("s1")],
    tasks: [task("a", "s1"), task("b", "s2"), task("c", null), task("d", "s1"), task("e", "gone")],
  });
  assert.deepEqual(groups.map((group) => [group.story.id, group.tasks.map((item) => item.id)]), [["s2", ["b"]], ["s1", ["a", "d"]]]);
  assert.deepEqual(unassigned.map((item) => item.id), ["c", "e"]);
  assert.deepEqual(groupTasksByStory({ stories: [], tasks: [] }), { groups: [], unassigned: [] });
});

test("Claimは担当・期限切れ（再取得可能）・担当なしを区別する", () => {
  assert.match(describeClaim(task("a", null, { activeClaim: { claimId: "c", principalId: "wrk", expiresAt: 0 } })), /^担当 wrk（期限 /);
  assert.equal(describeClaim(task("a", null, { reclaimable: true })), "Claimの期限切れ（再取得可能）");
  assert.equal(describeClaim(task("a", null)), "担当なし");
});

test("古い変更の追加読込は同じcursorを重複させず、理由だけを補足に出す", () => {
  assert.deepEqual(appendChangePage([change(5), change(4)], [change(4), change(3)]).map((item) => item.cursor), [5, 4, 3]);
  assert.equal(changeNote(change(1, { reason: "tests missing" })), "tests missing");
  assert.equal(changeNote(change(1, { reason: " " })), null);
  assert.equal(changeNote(change(1, { reason: 3 })), null);
  assert.equal(changeTypeLabel("TASK_REJECTED"), "差戻し");
  assert.equal(changeTypeLabel("UNKNOWN_TYPE"), "UNKNOWN_TYPE");
});

test("編集Changeはラベルと変更内容（タイトルは変更前後、説明・並び順は項目名）を出し、他のChangeには出さない", () => {
  assert.equal(changeTypeLabel("STORY_EDITED"), "Story編集");
  assert.equal(changeTypeLabel("TASK_EDITED"), "Task編集");
  const edited = (type: string, payload: Record<string, unknown>) => changeEditSummary({ type, payload });
  assert.equal(
    edited("TASK_EDITED", { changes: { title: { from: "旧", to: "新" }, description: { from: null, to: "x" } } }),
    "タイトル「旧」→「新」、説明",
  );
  assert.equal(edited("STORY_EDITED", { changes: { sortOrder: { from: 1, to: 2 } } }), "並び順");
  assert.equal(edited("STORY_EDITED", {}), null);
  assert.equal(edited("TASK_CREATED", { changes: { title: { from: "a", to: "b" } } }), null);
  assert.deepEqual(changeTarget({ type: "STORY_EDITED", entityId: "s1" }, { stories: [story("s1", { title: "認証" })], tasks: [] }), {
    kind: "story",
    id: "s1",
    title: "認証",
  });
});

test("最近の変更は同じProjectの複数StoryをStoryごとに識別し、Taskの変更はTask詳細の対象にする", () => {
  const overview = { stories: [story("s1", { title: "認証" }), story("s2", { title: "課金" })], tasks: [task("t1", "s1", { title: "ログイン" })] };
  const of = (type: string, entityId: string) => changeTarget({ type, entityId }, overview);
  assert.deepEqual(of("STORY_CREATED", "s1"), { kind: "story", id: "s1", title: "認証" });
  assert.deepEqual(of("STORY_CREATED", "s2"), { kind: "story", id: "s2", title: "課金" });
  assert.deepEqual(of("STORY_COMPLETED", "s2"), { kind: "story", id: "s2", title: "課金" });
  // 一覧に無いStoryもIDで識別できる。Taskは一覧にあるものだけリンクにする。
  assert.deepEqual(of("STORY_CANCELED", "gone"), { kind: "story", id: "gone", title: null });
  assert.deepEqual(of("TASK_CREATED", "t1"), { kind: "task", id: "t1", title: "ログイン" });
  assert.equal(of("TASK_CREATED", "gone"), null);
  assert.notEqual(storyAnchorId("s1"), storyAnchorId("s2"));
});

test("Web APIとrouteのpath", () => {
  assert.equal(executionPath("p1"), "/api/projects/p1/execution");
  assert.equal(executionPath("p1", "o 1"), "/api/projects/p1/execution?outcomeId=o%201");
  assert.equal(changesPath("p1"), "/api/projects/p1/changes?limit=20");
  assert.equal(changesPath("p1", 12, 5), "/api/projects/p1/changes?limit=5&beforeCursor=12");
  assert.equal(taskPath("p1", "t1"), "/projects/p1/tasks/t1");
});

test("閉ループの現在地は未接続・未還流・未評価を成功扱いせず区別し、最新の評価結果を出す", () => {
  const record = { summary: { state: "accepted" }, evidence: [] } as unknown as OutcomeExecutionRecord;
  const evaluation = (result: OutcomeEvaluation["result"]) => ({ result }) as OutcomeEvaluation;
  assert.equal(outcomeLoopStage({ storyCount: 0, record: null, evaluations: [] }).stage, "not_connected");
  assert.equal(outcomeLoopStage({ storyCount: 1, record: null, evaluations: [] }).stage, "not_reflected");
  // Executionがacceptedでも、Evaluationが無ければ達成と表示しない。
  const notEvaluated = outcomeLoopStage({ storyCount: 1, record, evaluations: [] });
  assert.equal(notEvaluated.stage, "not_evaluated");
  assert.doesNotMatch(notEvaluated.label, /達成/);
  assert.deepEqual(outcomeLoopStage({ storyCount: 1, record, evaluations: [evaluation("insufficient_evidence"), evaluation("achieved")] }), {
    stage: "evaluated", label: "評価済み: Evidence不足", result: "insufficient_evidence",
  });
});

test("Human介入の導線は状態とClaimで決まり、受入・差戻しはClaim中に出さない（Task 46）", () => {
  const claim = { claimId: "c1", principalId: "rev", expiresAt: 1 };
  assert.deepEqual(availableTaskOperations(task("t", null, { status: "todo" })), ["cancel"]);
  assert.deepEqual(availableTaskOperations(task("t", null, { status: "doing", activeClaim: { ...claim, principalId: "wrk" } })), ["cancel"]);
  assert.deepEqual(availableTaskOperations(task("t", null, { status: "in_review" })), ["accept", "reject"]);
  assert.deepEqual(availableTaskOperations(task("t", null, { status: "wait_accept" })), ["accept", "reject"]);
  assert.deepEqual(availableTaskOperations(task("t", null, { status: "in_review", activeClaim: claim })), []);
  for (const status of ["accepted", "rejected", "canceled"] as const) assert.deepEqual(availableTaskOperations(task("t", null, { status })), [], status);
  assert.equal(taskOperationPath("p1", "t1", "reject"), "/api/projects/p1/tasks/t1/reject");
  assert.equal(taskOperationPath("p1", "t1", "comments"), "/api/projects/p1/tasks/t1/comments");
});

test("Human operatorのPrincipalはMemberの表示名（無ければIDの先頭）で出し、Agent Principalはそのまま出す", () => {
  const names = new Map([["0123456789abcdef", "Alice"]]);
  assert.equal(describePrincipal("human:0123456789abcdef", names), "Human Alice");
  assert.equal(describePrincipal("human:fedcba9876543210"), "Human fedcba98");
  assert.equal(describePrincipal("wrk", names), "wrk");
});

test("手動起票（Task 47）: handoff・完了・取消のStoryと、handoff・受入済み・取消のTaskには編集・追加の導線を出さない", () => {
  assert.equal(isManualOpenStory(story("s")), true);
  assert.equal(isManualOpenStory(story("s", { status: "doing" })), true);
  assert.equal(isManualOpenStory(story("s", { correlationId: "outcome:o" })), false);
  assert.equal(isManualOpenStory(story("s", { status: "done" })), false);
  assert.equal(isManualOpenStory(story("s", { status: "canceled" })), false);

  assert.equal(isManualEditableTask(task("t", null), null), true);
  assert.equal(isManualEditableTask(task("t", "s", { status: "rejected" }), story("s")), true);
  assert.equal(isManualEditableTask(task("t", "s", { taskKey: "k" }), story("s")), false);
  assert.equal(isManualEditableTask(task("t", "s"), story("s", { correlationId: "outcome:o" })), false);
  assert.equal(isManualEditableTask(task("t", null, { status: "accepted" }), null), false);
  assert.equal(isManualEditableTask(task("t", null, { status: "canceled" }), null), false);

  const options = manualTaskStoryOptions([story("a"), story("h", { correlationId: "outcome:o" }), story("d", { status: "done" }), story("b", { status: "doing" })]);
  assert.deepEqual(options.map((item) => item.id), ["a", "b"]);
  // URLの`?storyId=`は選択肢にあるStoryだけを初期値にする。
  assert.equal(initialTaskStoryId("b", options), "b");
  assert.equal(initialTaskStoryId("h", options), "");
  assert.equal(initialTaskStoryId(null, options), "");
});

test("手動起票の画面・APIのpath", () => {
  assert.equal(storyCreatePath("p1"), "/projects/p1/stories/new");
  assert.equal(storyEditPath("p1", "s1"), "/projects/p1/stories/s1/edit");
  assert.equal(taskCreatePath("p1"), "/projects/p1/tasks/new");
  assert.equal(taskCreatePath("p1", "s 1"), "/projects/p1/tasks/new?storyId=s%201");
  assert.equal(taskEditPath("p1", "t1"), "/projects/p1/tasks/t1/edit");
  assert.equal(storiesApiPath("p1"), "/api/projects/p1/stories");
  assert.equal(storiesApiPath("p1", "s1"), "/api/projects/p1/stories/s1");
  assert.equal(tasksApiPath("p1"), "/api/projects/p1/tasks");
  assert.equal(tasksApiPath("p1", "t1"), "/api/projects/p1/tasks/t1");
});
