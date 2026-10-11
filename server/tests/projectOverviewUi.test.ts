import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTask } from "../src/web/features/execution/execution.ts";
import type { GrantRole } from "../src/web/features/grant/grants.ts";
import {
  agentsWithoutCredential,
  contributionStage,
  countWork,
  nextClaimExpiry,
  nextActionSummary,
  parseProjectView,
  planNextActions,
  projectContributionNote,
  projectContributions,
  projectViewPath,
  type NextActionInput,
} from "../src/web/features/project/overview.ts";
import type { Evaluability, OutcomeExecution, OutcomePosition, TargetWork } from "../src/web/features/workspace/overview.ts";
import { hashTargetId } from "../src/web/useHashTarget.ts";

/** Project詳細の概要（S10-03）の判定。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

const now = 1_000_000;
const task = (id: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask => ({
  id, projectId: "p1", storyId: "s1", title: id, description: null, status: "todo", rejectReason: null, createdAt: 0, updatedAt: 0, taskKey: null, activeClaim: null, reclaimable: false, ...overrides,
});
const held = (principalId: string) => ({ claimId: `c-${principalId}`, principalId, expiresAt: now + 60_000 });
const counts = (values: Partial<NonNullable<TargetWork["work"]>["taskCounts"]> = {}) => ({
  todo: 0, doing: 0, in_review: 0, wait_accept: 0, accepted: 0, rejected: 0, canceled: 0, ...values,
});
const work = (state: NonNullable<TargetWork["work"]>["state"], taskCounts: ReturnType<typeof counts>): TargetWork["work"] => ({ state, storyCount: 1, taskCounts });
const target = (projectId: string, targetWork: TargetWork["work"], projectStatus: TargetWork["projectStatus"] = "active"): TargetWork => ({
  outcomeId: "o", projectId, projectStatus, createdAt: 1, work: targetWork,
});
const awaiting = (unfinished: Evaluability["unfinishedTargets"] = []): Evaluability => ({ status: unfinished.length ? "awaiting_execution" : "evaluable", unfinishedTargets: unfinished });
const execution = (
  evaluability: Evaluability,
  targetCursors: OutcomeExecution["targetCursors"] = [],
  latestEvaluation: OutcomeExecution["latestEvaluation"] = null,
): OutcomeExecution => ({ evaluability, targetCursors, latestEvaluation });
const position = (id: string, targets: TargetWork[] | null, outcomeExecution: OutcomeExecution | null): OutcomePosition => ({
  outcome: { id, intentId: "i1", title: id }, targets, execution: outcomeExecution,
});
const allRoles = new Set<GrantRole>(["strategist", "researcher", "manager", "worker", "reviewer", "evaluator", "runtime"]);
const editor = { intervene: true, grantManage: false, credentialManage: false };
const viewer = { intervene: false, grantManage: false, credentialManage: false };
const administrator = { intervene: true, grantManage: true, credentialManage: true };
const input = (overrides: Partial<NextActionInput> = {}): NextActionInput => ({
  contributions: { items: [], unknown: [] }, tasks: [], assignedRoles: allRoles, agentsWithoutCredential: null, permissions: editor, now, ...overrides,
});
const contributionsOf = (outcomes: OutcomePosition[]) => projectContributions(outcomes, "p1");

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

test("貢献OutcomeはこのProjectがTargetのものだけを取り出し、ほかのTarget ProjectのWorkは件数だけにする", () => {
  const other = target("p2", work("incomplete", counts({ todo: 3 })));
  const mine = target("p1", work("incomplete", counts({ doing: 1 })));
  const { items, unknown } = contributionsOf([
    position("o-shared", [other, mine], execution(awaiting())),
    position("o-other", [other], execution(awaiting())),
    position("o-none", [], execution({ status: "no_targets", unfinishedTargets: [] })),
  ]);
  assert.deepEqual(items.map((item) => [item.outcome.id, item.target.projectId, item.otherTargets]), [["o-shared", "p1", 1]]);
  assert.deepEqual(unknown, []);
  // ほかのTarget ProjectのWork（p2の件数）を貢献へ持ち出さない。
  assert.ok(!JSON.stringify(items).includes("\"p2\""));
});

test("Target別Workを取得できないOutcomeは、貢献か断定せず確認できないものとして分ける", () => {
  const { items, unknown } = contributionsOf([position("o-failed", null, null), position("o-mine", [target("p1", null)], execution(awaiting()))]);
  assert.deepEqual(items.map((item) => item.outcome.id), ["o-mine"]);
  assert.deepEqual(unknown.map((item) => item.id), ["o-failed"]);
});

test("貢献Outcomeの評価の段階とWorkの説明は、Workspaceと同じ規則でこのProjectの還流を見る", () => {
  const [unreflected] = contributionsOf([position("o", [target("p1", work("accepted", counts({ accepted: 2 })))], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "not_reflected" }]), [{ projectId: "p1", executionCursor: null }]))]).items;
  assert.equal(contributionStage(unreflected!), "awaiting_execution");
  assert.equal(projectContributionNote(unreflected!), "Workは終わり、結果の還流待ちです");
  const [reflected] = contributionsOf([position("o", [target("p1", work("accepted", counts({ accepted: 2 })))], execution(awaiting(), [{ projectId: "p1", executionCursor: 4 }], { id: "e1", decided: false, targetCursors: [{ projectId: "p1", executionCursor: 4 }] }))]).items;
  assert.equal(contributionStage(reflected!), "decision_pending");
  assert.equal(projectContributionNote(reflected!), "結果は還流済みです");
  const [noStory] = contributionsOf([position("o", [target("p1", null)], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "not_reflected" }])))]).items;
  assert.equal(projectContributionNote(noStory!), "Storyはまだありません（ProjectのManagerの起票待ち）");
  const [unknownExecution] = contributionsOf([position("o", [target("p1", work("incomplete", counts({ todo: 1 })))], null)]).items;
  assert.equal(contributionStage(unknownExecution!), null);
  assert.equal(projectContributionNote(unknownExecution!), "還流・評価の状態を確認できません");
});

test("貢献OutcomeのStory起票・Task分解・還流の担当待ちはこのProjectのManager・Runtimeに出し、判断済みのOutcomeでは起票・分解を出さない", () => {
  const decided = { id: "e1", decided: true, targetCursors: [] };
  const actions = planNextActions(input({
    contributions: contributionsOf([
      position("o-story", [target("p1", null), target("p2", work("incomplete", counts({ todo: 1 })))], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "not_reflected" }]))),
      position("o-decompose", [target("p1", work("incomplete", counts()))], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "incomplete" }]))),
      position("o-reflect", [target("p1", work("accepted", counts({ accepted: 1 })))], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "not_reflected" }]))),
      position("o-running", [target("p1", work("incomplete", counts({ doing: 1 })))], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "incomplete" }]))),
      position("o-decided", [target("p1", null)], execution(awaiting(), [], decided)),
    ]),
  }));
  assert.deepEqual(actions.waiting.map((item) => [item.kind, item.role, item.outcomes.map((o) => o.id)]), [
    ["story", "manager", ["o-story"]],
    ["decompose", "manager", ["o-decompose"]],
    ["reflection", "runtime", ["o-reflect"]],
  ]);
  // 担当待ちはAgentの作業で、Humanの操作にしない。Intent・Outcome・評価はWorkspace scopeのため出さない。
  assert.deepEqual(actions.mine, []);
  assert.equal(nextActionSummary(actions), "あなたの操作はありません");
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

test("未割当のProject RoleはadministratorにはRoleの割当、それ以外には依頼先を出し、最大3件にする", () => {
  const busy = input({
    contributions: contributionsOf([position("o-story", [target("p1", null)], execution(awaiting([{ projectId: "p1", projectStatus: "active", reason: "not_reflected" }])))]),
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

test("還流・評価の状態やTargetを確認できないOutcomeは件数に出し、「今すぐ必要な操作はありません」と言わない", () => {
  const actions = planNextActions(input({
    contributions: contributionsOf([position("o-failed", null, null), position("o-unknown", [target("p1", null)], null)]),
  }));
  assert.equal(actions.outcomeFailures, 2);
  // 還流・評価の状態が無いOutcomeは、判断済みか分からないため起票待ちと断定しない。
  assert.deepEqual(actions.waiting, []);
  assert.equal(nextActionSummary(actions), "あなたの操作はありません");
  assert.equal(nextActionSummary(planNextActions(input())), "今すぐ必要な操作はありません");
  // WorkspaceのDirectionを閲覧できない場合は、Outcomeの担当待ちを判定せず、Taskの担当待ちだけを出す。
  const withoutDirection = planNextActions(input({ contributions: null, tasks: [task("t-todo")] }));
  assert.deepEqual(withoutDirection.waiting.map((item) => item.kind), ["todo"]);
  assert.equal(withoutDirection.outcomeFailures, 0);
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

test("表示中にClaimの期限を過ぎたら、同じTaskを再取得待ちとして数え直し、担当待ちに出す", () => {
  const expiresAt = now + 60_000;
  const tasks = [task("doing", { status: "doing", activeClaim: { claimId: "c", principalId: "w", expiresAt } }), task("review", { status: "in_review", activeClaim: held("r") })];
  assert.equal(nextClaimExpiry(tasks, now), expiresAt);
  assert.deepEqual(countWork(tasks, now), [{ bucket: "doing", count: 1 }, { bucket: "in_review", count: 1 }]);
  assert.deepEqual(planNextActions(input({ tasks })).waiting, []);
  const later = expiresAt + 1;
  assert.deepEqual(countWork(tasks, later), [{ bucket: "reclaimable", count: 1 }, { bucket: "in_review", count: 1 }]);
  assert.deepEqual(planNextActions(input({ tasks, now: later })).waiting.map((item) => item.kind), ["reclaimable", "in_review"]);
  assert.equal(nextClaimExpiry(tasks, later), null);
  assert.equal(nextClaimExpiry([task("todo")], now), null);
});

test("URLのhashは要素idにdecodeし、空や不正なpercent-encodingは無視する", () => {
  assert.equal(hashTargetId("#execution-task-t1"), "execution-task-t1");
  assert.equal(hashTargetId("#agent-role-%E6%9C%AA"), "agent-role-未");
  assert.equal(hashTargetId(""), null);
  assert.equal(hashTargetId("#"), null);
  assert.equal(hashTargetId("#%"), null);
  assert.equal(hashTargetId("#%E0%A4%A"), null);
});
