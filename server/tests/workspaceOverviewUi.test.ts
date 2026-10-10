import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionSummary,
  evaluationStage,
  pickOpenProject,
  planWorkspaceAttention,
  projectTargetNote,
  type Evaluability,
  type OutcomeExecution,
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
/** 還流・評価の状態。`cursors`は現在のTarget別還流cursor（既定は全Target未還流）、`latestEvaluation`は最新Evaluation。 */
const execution = (
  evaluability: Evaluability,
  cursors: OutcomeExecution["targetCursors"] = [],
  latestEvaluation: OutcomeExecution["latestEvaluation"] = null,
): OutcomeExecution => ({ evaluability, targetCursors: cursors, latestEvaluation });
const outcome = (id: string, targets: TargetWork[] | null, evaluability: Evaluability | OutcomeExecution | null): OutcomePosition => ({
  outcome: { id, intentId: "i-1", title: `Outcome ${id}` },
  targets,
  execution: evaluability === null || "evaluability" in evaluability ? evaluability : execution(evaluability),
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
      outcome("evaluate", [target("p-1", done), target("p-2", done)], execution({ status: "evaluable", unfinishedTargets: [] }, [
        { projectId: "p-1", executionCursor: 3 },
        { projectId: "p-2", executionCursor: 5 },
      ])),
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

test("StoryがあってもTaskが無いactiveなTargetは、ProjectのManagerのTask分解待ちにする（ExecutionSummaryのincompleteと同じ）", () => {
  const { items } = planWorkspaceAttention({
    activeIntent: true,
    outcomes: [
      outcome("split", [
        target("p-empty", { state: "incomplete", storyCount: 1, taskCounts: counts() }),
        target("p-old", { state: "incomplete", storyCount: 1, taskCounts: counts() }, "archived"),
      ], awaiting([
        { projectId: "p-empty", projectStatus: "active", reason: "not_reflected" },
      ])),
    ],
  });
  assert.deepEqual(items.map(({ kind, actor, refs }) => [kind, actor, refs.map(({ projectId }) => projectId)]), [["decompose", "manager", ["p-empty"]]]);
  assert.equal(attentionSummary({ items, outcomeFailures: 0 }), null);
});

test("全Target還流済みの評価待ちと、評価済みの判断待ち・新しい還流の再評価待ち・判断済みを、最新Evaluationと評価snapshotのcursorで区別する", () => {
  const done = { state: "accepted" as const, storyCount: 1, taskCounts: counts({ accepted: 1 }) };
  const evaluable: Evaluability = { status: "evaluable", unfinishedTargets: [] };
  const cursors = [{ projectId: "p-1", executionCursor: 7 }];
  const evaluated = (decided: boolean, executionCursor: number): OutcomeExecution["latestEvaluation"] => ({ id: "e-1", decided, targetCursors: [{ projectId: "p-1", executionCursor }] });
  const plan = (state: OutcomeExecution) => planWorkspaceAttention({ activeIntent: true, outcomes: [outcome("o", [target("p-1", done)], state)] }).items.map(({ kind, actor }) => [kind, actor]);

  const unevaluated = execution(evaluable, cursors);
  assert.equal(evaluationStage(unevaluated), "evaluation_pending");
  assert.deepEqual(plan(unevaluated), [["evaluation", "evaluator"]]);

  // 評価済みでもTargetの評価可能性はevaluableのまま。評価待ちとせず、Strategistの判断待ちにする。
  const awaitingDecision = execution(evaluable, cursors, evaluated(false, 7));
  assert.equal(evaluationStage(awaitingDecision), "decision_pending");
  assert.deepEqual(plan(awaitingDecision), [["decision", "strategist"]]);

  // 判断待ちの間に新しい還流があれば、判断待ちに加えて再評価待ち（Orchestratorも両方を起動する）。
  const reevaluate = execution(evaluable, [{ projectId: "p-1", executionCursor: 9 }], evaluated(false, 7));
  assert.deepEqual(plan(reevaluate), [["decision", "strategist"], ["evaluation", "evaluator"]]);
  // Targetの構成が変わった（評価snapshotに無いTargetがある）場合も未評価。
  assert.deepEqual(plan(execution(evaluable, [...cursors, { projectId: "p-2", executionCursor: 1 }], evaluated(false, 7))), [["decision", "strategist"], ["evaluation", "evaluator"]]);

  // 判断済みのOutcomeは、新しい還流があってもEvaluator・Strategist・Managerを待たない（Orchestratorの`isLive`と同じ）。
  const decided = execution(evaluable, [{ projectId: "p-1", executionCursor: 9 }], evaluated(true, 7));
  assert.equal(evaluationStage(decided), "decided");
  assert.deepEqual(plan(decided), []);
  assert.deepEqual(
    planWorkspaceAttention({ activeIntent: true, outcomes: [outcome("o", [target("p-1", null)], execution({ status: "awaiting_execution", unfinishedTargets: [] }, [], evaluated(true, 7)))] }).items,
    [],
  );

  assert.equal(evaluationStage(execution({ status: "awaiting_execution", unfinishedTargets: [] })), "awaiting_execution");
});

test("Project一覧のTarget表示は、Intent・Outcomeの取得失敗・一部OutcomeのTarget取得失敗を0件と断定しない", () => {
  const outcomes = [outcome("a", [target("p-1", null)], null), outcome("b", [target("p-1", null), target("p-2", null)], null)];
  assert.equal(projectTargetNote(outcomes, "p-1"), "Active Outcome 2件のTarget");
  assert.equal(projectTargetNote(outcomes, "p-2"), "Active Outcome 1件のTarget");
  assert.equal(projectTargetNote(outcomes, "p-3"), "Active OutcomeのTargetではありません");
  assert.equal(projectTargetNote([], "p-3"), "Active OutcomeのTargetではありません");

  const partial = [...outcomes, outcome("c", null, null)];
  assert.equal(projectTargetNote(partial, "p-1"), "Active Outcome 2件のTarget（ほかOutcome 1件は確認できません）");
  assert.equal(projectTargetNote(partial, "p-3"), "Targetか確認できません（Outcome 1件のTargetを取得できません）");
  assert.equal(projectTargetNote(null, "p-1"), "Targetか確認できません（Intent・Outcomeを取得できません）");
});
