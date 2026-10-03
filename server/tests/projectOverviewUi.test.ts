import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTask, LoopStage } from "../src/web/features/execution/execution.ts";
import type { GrantRole } from "../src/web/features/grant/grants.ts";
import {
  agentsWithoutCredential,
  countWork,
  nextActionSummary,
  parseProjectView,
  planNextActions,
  projectViewPath,
  type NextActionInput,
  type OutcomeProgress,
} from "../src/web/features/project/overview.ts";

/** Project詳細の概要（Task 03）の判定。画面の描画・実ブラウザ確認はTaskの作業コメントに記録する。 */

const now = 1_000_000;
const task = (id: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask => ({
  id, projectId: "p1", storyId: "s1", title: id, description: null, status: "todo", rejectReason: null, createdAt: 0, updatedAt: 0, taskKey: null, activeClaim: null, reclaimable: false, ...overrides,
});
const held = (principalId: string) => ({ claimId: `c-${principalId}`, principalId, expiresAt: now + 60_000 });
const stage = (value: LoopStage["stage"]): LoopStage =>
  value === "evaluated" ? { stage: value, label: "評価済み", result: "achieved" } : { stage: value, label: value };
const outcome = (id: string, value: LoopStage["stage"] | null, tasks: ExecutionTask[] = []): OutcomeProgress => ({
  outcome: { id, intentId: "i1", title: id }, stage: value === null ? null : stage(value), tasks,
});
const allRoles = new Set<GrantRole>(["strategist", "researcher", "manager", "worker", "reviewer", "evaluator", "runtime"]);
const editor = { directionWrite: true, intervene: true, grantManage: false, credentialManage: false };
const viewer = { directionWrite: false, intervene: false, grantManage: false, credentialManage: false };
const administrator = { directionWrite: true, intervene: true, grantManage: true, credentialManage: true };
const input = (overrides: Partial<NextActionInput> = {}): NextActionInput => ({
  activeIntentId: "i1", outcomes: [outcome("o-done", "evaluated")], tasks: [], assignedRoles: allRoles, agentsWithoutCredential: null, permissions: editor, now, ...overrides,
});

test("viewは?view=で表し、指定無し・不正な値は概要にする", () => {
  assert.equal(parseProjectView("work"), "work");
  assert.equal(parseProjectView("settings"), "settings");
  assert.equal(parseProjectView(null), "overview");
  assert.equal(parseProjectView("unknown"), "overview");
  assert.equal(projectViewPath("p1", "work", "execution-task-t1"), "/projects/p1?view=work#execution-task-t1");
  assert.equal(projectViewPath("p1", "settings"), "/projects/p1?view=settings");
});

test("現在地のWorkは各Taskを1区分に数え、レビュー待ちと受入待ちを分け、0件を省く", () => {
  const counts = countWork([
    task("todo"),
    task("doing", { status: "doing", activeClaim: held("w") }),
    task("reclaimable", { status: "doing", reclaimable: true }),
    task("expired-after-fetch", { status: "doing", activeClaim: { claimId: "c", principalId: "w", expiresAt: now } }),
    task("review", { status: "in_review" }),
    task("accept", { status: "wait_accept", activeClaim: held("m") }),
    task("accepted", { status: "accepted" }),
    task("canceled", { status: "canceled" }),
  ], now);
  assert.deepEqual(counts, [
    { bucket: "todo", count: 1 },
    { bucket: "doing", count: 1 },
    { bucket: "reclaimable", count: 2 },
    { bucket: "in_review", count: 1 },
    { bucket: "wait_accept", count: 1 },
  ]);
});

test("Active Intentが無いProjectでは「Intentを登録」だけを出し「Outcomeを登録」を出さない", () => {
  const actions = planNextActions(input({ activeIntentId: null, outcomes: [] }));
  assert.deepEqual(actions.mine.map((action) => action.kind), ["intent"]);
  assert.equal(actions.mine[0]?.allowed, true);
  const forViewer = planNextActions(input({ activeIntentId: null, outcomes: [], permissions: viewer }));
  assert.deepEqual(forViewer.mine.map((action) => [action.kind, action.allowed, "requestTo" in action ? action.requestTo : null]), [["intent", false, "Editor以上へ依頼"]]);
});

test("Active IntentがありActive Outcomeが無いProjectでだけ「Outcomeを登録」を出す", () => {
  assert.deepEqual(planNextActions(input({ outcomes: [] })).mine.map((action) => action.kind), ["outcome"]);
  assert.deepEqual(planNextActions(input()).mine, []);
});

test("Story起票待ち・評価待ちはManager・Evaluatorが割当済みでも担当待ちに出し、「今すぐ必要な操作はありません」と言わない", () => {
  const actions = planNextActions(input({ outcomes: [outcome("o-new", "not_connected"), outcome("o-eval", "not_evaluated")] }));
  assert.deepEqual(actions.mine, []);
  assert.deepEqual(actions.waiting.map((item) => [item.kind, item.count, item.unassigned, item.outcomes.map((o) => o.id)]), [
    ["story", 1, false, ["o-new"]],
    ["evaluation", 1, false, ["o-eval"]],
  ]);
  assert.equal(nextActionSummary(actions), "あなたの操作はありません");
});

test("還流待ちは未完了のTaskが残らないnot_reflectedのOutcomeだけを数える", () => {
  const actions = planNextActions(input({
    outcomes: [
      outcome("o-running", "not_reflected", [task("t-open", { status: "in_review" })]),
      outcome("o-finished", "not_reflected", [task("t-accepted", { status: "accepted" })]),
    ],
  }));
  assert.deepEqual(actions.waiting.map((item) => [item.kind, item.outcomes.map((o) => o.id)]), [["reflection", ["o-finished"]]]);
});

test("Taskの担当待ちは期限内Claimの無いものだけを区分ごとに数え、レビュー待ちと受入待ちを分ける", () => {
  const actions = planNextActions(input({
    tasks: [
      task("t-todo"),
      task("t-rejected", { status: "rejected" }),
      task("t-reclaimable", { status: "doing", reclaimable: true }),
      task("t-doing", { status: "doing", activeClaim: held("w") }),
      task("t-review", { status: "in_review" }),
      task("t-review-held", { status: "in_review", activeClaim: held("r") }),
      task("t-accept", { status: "wait_accept" }),
    ],
  }));
  assert.deepEqual(actions.waiting.map((item) => [item.kind, item.taskIds]), [
    ["todo", ["t-todo"]],
    ["rejected", ["t-rejected"]],
    ["reclaimable", ["t-reclaimable"]],
    ["in_review", ["t-review"]],
    ["wait_accept", ["t-accept"]],
  ]);
  // 受入待ちの確認はeditor以上の操作。レビュー待ちはReviewerの担当で、Humanの操作として勧めない。
  assert.deepEqual(actions.mine.map((action) => [action.kind, action.label]), [["accept", "受入待ちのTaskを確認（1件）"]]);
  assert.deepEqual(planNextActions(input({ tasks: [task("t-accept", { status: "wait_accept" })], permissions: viewer })).mine, []);
});

test("未割当のRoleはadministratorには割当、それ以外には依頼先を出し、最大3件にする", () => {
  const busy = input({
    outcomes: [outcome("o-new", "not_connected"), outcome("o-eval", "not_evaluated")],
    tasks: [task("t-todo"), task("t-review", { status: "in_review" })],
    assignedRoles: new Set<GrantRole>(),
  });
  const forEditor = planNextActions(busy);
  assert.deepEqual(forEditor.mine.map((action) => [action.label, action.allowed]), [
    ["Managerを割り当てる", false],
    ["Workerを割り当てる", false],
    ["Reviewerを割り当てる", false],
  ]);
  assert.ok(forEditor.waiting.every((item) => item.unassigned));
  const forAdministrator = planNextActions({ ...busy, permissions: administrator, agentsWithoutCredential: ["agent-a"] });
  assert.ok(forAdministrator.mine.every((action) => action.allowed));
  assert.equal(forAdministrator.mine.length, 3);
});

test("Credentialの発行はCredentialを参照できるadministratorにだけ出す", () => {
  assert.deepEqual(planNextActions(input({ permissions: administrator, agentsWithoutCredential: ["agent-a"] })).mine.map((action) => action.kind), ["credential"]);
  assert.deepEqual(planNextActions(input({ agentsWithoutCredential: null })).mine, []);
});

test("Outcomeの取得失敗は件数に含めず、担当待ちが無くても「今すぐ必要な操作はありません」と言わない", () => {
  const actions = planNextActions(input({ outcomes: [outcome("o-failed", null)] }));
  assert.equal(actions.outcomeFailures, 1);
  assert.deepEqual(actions.mine, []);
  assert.equal(nextActionSummary(actions), "あなたの操作はありません");
  assert.equal(nextActionSummary(planNextActions(input())), "今すぐ必要な操作はありません");
});

test("Credentialの無い割当済みAgentを、Runtimeはruntime、それ以外はagentのCredentialで判定する", () => {
  const grants = [
    { principalId: "a-ok", role: "worker" as const },
    { principalId: "a-ok", role: "reviewer" as const },
    { principalId: "a-revoked", role: "manager" as const },
    { principalId: "a-expired", role: "evaluator" as const },
    { principalId: "rt", role: "runtime" as const },
    { principalId: "a-ok-runtime", role: "runtime" as const },
  ];
  // 取消・期限切れのCredentialは呼出側（`credentialStatus`）で除き、有効なものだけを渡す。
  assert.deepEqual(agentsWithoutCredential(grants, [
    { principalId: "a-ok", kind: "agent" },
    { principalId: "rt", kind: "agent" },
    { principalId: "a-ok-runtime", kind: "runtime" },
  ]), ["a-revoked", "a-expired", "rt"]);
});
