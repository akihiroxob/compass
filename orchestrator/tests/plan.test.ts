import assert from "node:assert/strict";
import test from "node:test";
import { planDispatches } from "../src/plan.ts";
import type { OrchestrationOutcome, OrchestrationResearchRequest, OrchestrationState } from "../src/state.ts";

const projectId = "p-1";

const stateOf = (overrides: Partial<OrchestrationState> = {}): OrchestrationState => ({
  project: { id: projectId, name: "Compass", status: "active" },
  activeIntent: { id: "i-1", status: "active", updatedAt: 1 },
  outcomes: [],
  intentResearchRequests: [],
  openResearchRequests: [],
  observedAt: 1,
  ...overrides,
});

const research = (id: string, status: string): OrchestrationResearchRequest => ({
  id,
  kind: "decision",
  status,
  originIntentId: "i-1",
  originOutcomeId: null,
  updatedAt: 1,
});

const outcome = (id: string, overrides: Partial<OrchestrationOutcome> = {}): OrchestrationOutcome => ({
  id,
  status: "active",
  updatedAt: 1,
  work: { state: "incomplete", storyCount: 1, taskCount: 1 },
  execution: null,
  latestEvaluation: null,
  ...overrides,
});

const roles = (state: OrchestrationState) => planDispatches(state).map(({ role, subject }) => `${role}:${subject.kind}:${subject.id}`);

test("Outcome・Researchの無いActive IntentはStrategistへ渡し、Researchを自動で必須にしない", () => {
  const [dispatch, ...rest] = planDispatches(stateOf());
  assert.equal(rest.length, 0);
  assert.equal(dispatch!.role, "strategist");
  assert.deepEqual(dispatch!.subject, { kind: "intent", id: "i-1" });
  assert.ok(dispatch!.key.startsWith(`${projectId}:strategist:intent:i-1:`));
  // Researcherは起動しない。Researchの要否は起動されたStrategistが判断する。
  assert.equal(planDispatches(stateOf()).some(({ role }) => role === "researcher"), false);
});

test("同じ状態からは同じkeyになり、状態が進めば新しいkeyになる", () => {
  const first = planDispatches(stateOf())[0]!.key;
  assert.equal(planDispatches(stateOf({ observedAt: 999 }))[0]!.key, first);
  const closed = stateOf({ intentResearchRequests: [research("r-1", "not_needed")] });
  const afterResearch = planDispatches(closed)[0]!;
  assert.equal(afterResearch.role, "strategist");
  assert.notEqual(afterResearch.key, first);
});

test("未終了のResearch RequestはResearcherへ渡し、その間Strategistを起動しない", () => {
  const open = research("r-1", "requested");
  assert.deepEqual(roles(stateOf({ openResearchRequests: [open], intentResearchRequests: [open] })), [
    "researcher:research_request:r-1",
  ]);
  // 発端Intentの無いRequest（project_watch）もResearcherへ渡す。
  const watch = { ...research("r-2", "running"), kind: "project_watch", originIntentId: null };
  assert.deepEqual(roles(stateOf({ activeIntent: null, openResearchRequests: [watch] })), ["researcher:research_request:r-2"]);
});

test("未分解のOutcomeはManagerへ渡し、分解の内容は判断しない", () => {
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-1", { work: null })] })), ["manager:outcome:o-1"]);
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-1", { work: { state: "incomplete", storyCount: 1, taskCount: 0 } })] })), [
    "manager:outcome:o-1",
  ]);
  // Taskがあれば実行中で、Orchestratorは何も起動しない（Worker / ReviewerはRalphの責務）。
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-1")] })), []);
  // 取消済みのOutcomeは対象外で、IntentがStrategistへ戻る。
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-1", { status: "cancelled", work: null })] })).map((item) => item.split(":")[0]), [
    "strategist",
  ]);
});

test("還流済みで未評価のExecutionはEvaluatorへ、判断待ちのEvaluationはStrategistへ渡す", () => {
  const executed = outcome("o-1", { execution: { state: "accepted", executionCursor: 10 } });
  assert.deepEqual(roles(stateOf({ outcomes: [executed] })), ["evaluator:outcome:o-1"]);
  assert.equal(planDispatches(stateOf({ outcomes: [executed] }))[0]!.key, `${projectId}:evaluator:outcome:o-1:10`);
  // 実行中（incomplete）は評価しない。
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-1", { execution: { state: "incomplete", executionCursor: 10 } })] })), []);

  const evaluated = outcome("o-1", {
    execution: { state: "accepted", executionCursor: 10 },
    latestEvaluation: { id: "e-1", executionCursor: 10, decisionId: null, createdAt: 1 },
  });
  assert.deepEqual(roles(stateOf({ outcomes: [evaluated] })), ["strategist:evaluation:e-1"]);
  // Executionが進めば再評価する（判断待ちのEvaluationとは別の起動）。
  const advanced = { ...evaluated, execution: { state: "accepted", executionCursor: 12 } };
  assert.deepEqual(roles(stateOf({ outcomes: [advanced] })).sort(), ["evaluator:outcome:o-1", "strategist:evaluation:e-1"]);
});

test("判断済みのEvaluationのOutcomeは進行中とみなさず、次の判断が無ければIntentをStrategistへ戻す", () => {
  const decided = outcome("o-1", {
    execution: { state: "accepted", executionCursor: 10 },
    latestEvaluation: { id: "e-1", executionCursor: 10, decisionId: "d-1", createdAt: 1 },
  });
  // 判断（追加Research）でRequestが開いている間はResearcherだけ。
  const open = research("r-1", "requested");
  assert.deepEqual(roles(stateOf({ outcomes: [decided], openResearchRequests: [open], intentResearchRequests: [open] })), [
    "researcher:research_request:r-1",
  ]);
  // Researchが終わればStrategistへ戻す。
  assert.deepEqual(roles(stateOf({ outcomes: [decided], intentResearchRequests: [research("r-1", "completed")] })), [
    "strategist:intent:i-1",
  ]);
  // 次のOutcomeが確定していればIntentはStrategistへ戻らない。
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-2", { work: null }), decided] })), ["manager:outcome:o-2"]);
});

test("archivedのProjectと、Active Intentの無いProjectでは何も起動しない", () => {
  assert.deepEqual(planDispatches(stateOf({ project: { id: projectId, name: "Compass", status: "archived" } })), []);
  assert.deepEqual(planDispatches(stateOf({ activeIntent: null })), []);
});
