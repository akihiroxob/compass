import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionSummary,
  countTargetOutcomes,
  pickOpenProject,
  planWorkspaceAttention,
  type Evaluability,
  type OutcomePosition,
  type TargetWork,
} from "../src/web/features/workspace/overview.ts";

/** Workspaceの概要（S10-01）の現在地・要対応の判定。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

const counts = (values: Partial<NonNullable<TargetWork["work"]>["taskCounts"]> = {}) => ({
  todo: 0, doing: 0, in_review: 0, wait_accept: 0, accepted: 0, rejected: 0, canceled: 0, ...values,
});
const target = (projectId: string, work: TargetWork["work"], projectStatus: TargetWork["projectStatus"] = "active"): TargetWork => ({
  outcomeId: "o", projectId, projectStatus, createdAt: 1, work,
});
const outcome = (id: string, targets: TargetWork[] | null, evaluability: Evaluability | null): OutcomePosition => ({
  outcome: { id, intentId: "i-1", title: `Outcome ${id}` },
  targets,
  evaluability,
});
const awaiting = (unfinished: Evaluability["unfinishedTargets"]): Evaluability => ({ status: "awaiting_execution", unfinishedTargets: unfinished });

test("Active Intentが無ければIntentの登録、ActiveなOutcomeが無ければOutcomeの登録だけをHumanの要対応にする", () => {
  assert.deepEqual(planWorkspaceAttention({ activeIntent: false, outcomes: [] }).items.map(({ kind, actor }) => [kind, actor]), [["intent", "human"]]);
  assert.deepEqual(planWorkspaceAttention({ activeIntent: true, outcomes: [] }).items.map(({ kind, actor }) => [kind, actor]), [["outcome", "human"]]);
});

test("OutcomeごとにTarget Project別のWorkから次に動く主体を上流から順に出し、根拠のOutcome・Project・件数を持つ", () => {
  const { items, outcomeFailures } = planWorkspaceAttention({
    activeIntent: true,
    outcomes: [
      outcome("a", [], { status: "no_targets", unfinishedTargets: [] }),
      outcome("b", [
        target("p-consumer", null),
        target("p-business", { state: "incomplete", storyCount: 2, taskCounts: counts({ todo: 1, doing: 3, in_review: 2, wait_accept: 1, rejected: 1 }) }),
      ], awaiting([
        { projectId: "p-consumer", projectStatus: "active", reason: "not_reflected" },
        { projectId: "p-business", projectStatus: "active", reason: "not_reflected" },
      ])),
    ],
  });
  assert.equal(outcomeFailures, 0);
  assert.deepEqual(items.map(({ kind, actor }) => [kind, actor]), [
    ["no_targets", "strategist"],
    ["story", "manager"],
    ["todo", "worker"],
    ["rejected", "worker"],
    ["in_review", "reviewer"],
    ["wait_accept", "manager"],
  ]);
  assert.deepEqual(items.find(({ kind }) => kind === "story")?.refs.map(({ outcome: { id }, projectId }) => [id, projectId]), [["b", "p-consumer"]]);
  assert.deepEqual(items.find(({ kind }) => kind === "in_review")?.refs.map(({ projectId, count }) => [projectId, count]), [["p-business", 2]]);
  // 作業中（doing）はClaimの有効性を判断できないため、要対応に出さない。
  assert.equal(items.some(({ refs }) => refs.some(({ count }) => count === 3)), false);
});

test("Workが終わって未還流ならRuntimeの還流待ち、全Target還流済みならEvaluatorの評価待ち、archived Targetの未完了はStrategistの再計画待ち", () => {
  const done = { state: "accepted" as const, storyCount: 1, taskCounts: counts({ accepted: 2 }) };
  const { items } = planWorkspaceAttention({
    activeIntent: true,
    outcomes: [
      outcome("reflect", [target("p-1", done)], awaiting([{ projectId: "p-1", projectStatus: "active", reason: "not_reflected" }])),
      outcome("evaluate", [target("p-1", done), target("p-2", done)], { status: "evaluable", unfinishedTargets: [] }),
      outcome("replan", [target("p-old", null, "archived"), target("p-1", done)], {
        status: "replan_required",
        unfinishedTargets: [{ projectId: "p-old", projectStatus: "archived", reason: "not_reflected" }],
      }),
    ],
  });
  assert.deepEqual(items.map(({ kind, refs }) => [kind, refs.map(({ outcome: { id }, projectId }) => `${id}:${projectId ?? "-"}`)]), [
    ["replan", ["replan:p-old"]],
    ["reflection", ["reflect:p-1"]],
    ["evaluation", ["evaluate:-"]],
  ]);
  // archivedのTargetにはStoryの起票を求めない。
  assert.equal(items.some(({ kind }) => kind === "story"), false);
});

test("取得に失敗したOutcomeは要対応を判定せず件数で返し、空・Targetなしと区別する", () => {
  const attention = planWorkspaceAttention({
    activeIntent: true,
    outcomes: [outcome("ok", [target("p-1", { state: "incomplete", storyCount: 1, taskCounts: counts({ doing: 1 }) })], awaiting([])), outcome("failed", null, null), outcome("partial", [], null)],
  });
  assert.deepEqual(attention.items, []);
  assert.equal(attention.outcomeFailures, 2);
  assert.equal(attentionSummary(attention), "確認できたOutcomeに要対応はありません");
  assert.equal(attentionSummary({ items: [], outcomeFailures: 0 }), "要対応はありません");
  assert.equal(attentionSummary(planWorkspaceAttention({ activeIntent: false, outcomes: [] })), null);
});

test("Outcome・Intentの詳細はProject Membershipで開けるProject（Targetを優先、無ければactive）から開き、無ければリンクにしない", () => {
  const projects = [
    { id: "p-locked", status: "active" as const, canOpen: false },
    { id: "p-archived", status: "archived" as const, canOpen: true },
    { id: "p-open", status: "active" as const, canOpen: true },
  ];
  assert.equal(pickOpenProject(["p-locked", "p-archived"], projects), "p-archived");
  assert.equal(pickOpenProject(["p-locked"], projects), "p-open");
  assert.equal(pickOpenProject([], projects), "p-open");
  assert.equal(pickOpenProject([], [{ id: "p-locked", status: "active", canOpen: false }]), null);
});

test("ProjectがTargetになっているActive Outcomeを数え、取得できないOutcomeは数えない", () => {
  const outcomes = [outcome("a", [target("p-1", null)], null), outcome("b", [target("p-1", null), target("p-2", null)], null), outcome("c", null, null)];
  assert.equal(countTargetOutcomes(outcomes, "p-1"), 2);
  assert.equal(countTargetOutcomes(outcomes, "p-2"), 1);
  assert.equal(countTargetOutcomes(outcomes, "p-3"), 0);
});
