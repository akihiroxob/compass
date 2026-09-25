import assert from "node:assert/strict";
import test from "node:test";
import {
  availableTaskOperations,
  describePrincipal,
  taskOperationPath,
  appendChangePage,
  changeNote,
  changeTarget,
  changesPath,
  changeTypeLabel,
  describeClaim,
  executionPath,
  groupTasksByStory,
  storyAnchorId,
  outcomeLoopStage,
  type ExecutionChange,
  type ExecutionStory,
  type ExecutionTask,
  type OutcomeEvaluation,
  type OutcomeExecutionRecord,
} from "../src/frontend/features/execution/execution.ts";
import { taskPath } from "../src/frontend/paths.ts";

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
