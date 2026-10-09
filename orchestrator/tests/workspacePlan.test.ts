import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decideLaunch, DispatchStore, finishRecord } from "../src/dispatchStore.ts";
import { planWorkspaceDispatches, type WorkspaceDispatch } from "../src/plan.ts";
import type {
  OrchestrationResearchRequest,
  WorkspaceOrchestrationOutcome,
  WorkspaceOrchestrationState,
  WorkspaceOrchestrationTarget,
} from "../src/state.ts";

/**
 * Workspace 単位の dispatch 規則（handoff v2「20」）。入力は Server の `get_workspace_orchestration_state` と同じ形の固定状態で、
 * 評価可能性（`evaluability`）は Server の判定（Direction の `assessOutcomeEvaluability`）と同じ規則で組み立てる。
 */

const workspaceId = "w-1";

const stateOf = (overrides: Partial<WorkspaceOrchestrationState> = {}): WorkspaceOrchestrationState => ({
  workspace: { id: workspaceId, name: "Workspace", status: "active" },
  projects: [
    { id: "p-a", name: "A" },
    { id: "p-b", name: "B" },
  ],
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

const decomposed = { state: "incomplete", storyCount: 1, taskCount: 2 };

const target = (projectId: string, overrides: Partial<WorkspaceOrchestrationTarget> = {}): WorkspaceOrchestrationTarget => ({
  projectId,
  projectStatus: "active",
  work: decomposed,
  execution: null,
  ...overrides,
});

const done = (cursor: number) => ({ state: "accepted", executionCursor: cursor });

/** Server と同じ規則で全 Target の還流状況から評価可能性を決める。 */
const evaluabilityOf = (targets: WorkspaceOrchestrationTarget[]): WorkspaceOrchestrationOutcome["evaluability"] => {
  if (targets.length === 0) return { status: "no_targets", unfinishedTargets: [] };
  const unfinishedTargets = targets.flatMap(({ projectId, projectStatus, execution }) => {
    const reason = execution === null ? "not_reflected" : execution.state === "incomplete" ? "incomplete" : null;
    return reason ? [{ projectId, projectStatus, reason }] : [];
  });
  if (unfinishedTargets.length === 0) return { status: "evaluable", unfinishedTargets };
  const archived = unfinishedTargets.some(({ projectStatus }) => projectStatus === "archived");
  return { status: archived ? "replan_required" : "awaiting_execution", unfinishedTargets };
};

const outcome = (
  id: string,
  targets: WorkspaceOrchestrationTarget[],
  overrides: Partial<WorkspaceOrchestrationOutcome> = {},
): WorkspaceOrchestrationOutcome => ({
  id,
  status: "active",
  updatedAt: 1,
  targets,
  evaluability: evaluabilityOf(targets),
  latestEvaluation: null,
  ...overrides,
});

const roles = (state: WorkspaceOrchestrationState) =>
  planWorkspaceDispatches(state).map(({ role, projectId, subject }) => `${role}${projectId ? `@${projectId}` : ""}:${subject.kind}:${subject.id}`);

test("TargetなしのOutcomeはWorkspaceのStrategistへ渡し、Project選択をOrchestratorで推論しない", () => {
  const [dispatch, ...rest] = planWorkspaceDispatches(stateOf({ outcomes: [outcome("o-1", [])] }));
  assert.equal(rest.length, 0, "activeなProjectがあってもmanagerを起動せず、IntentもStrategistへ戻さない");
  assert.equal(dispatch!.role, "strategist");
  assert.equal(dispatch!.workspaceId, workspaceId);
  assert.equal(dispatch!.projectId, null);
  assert.deepEqual(dispatch!.subject, { kind: "outcome", id: "o-1" });
  assert.equal(dispatch!.key, `${workspaceId}:strategist:outcome:o-1:no_targets`);
});

test("A/B TargetでBだけStoryが無ければBのmanagerだけを起動し、keyはWorkspace・Project・Outcomeで決まる", () => {
  const onlyB = stateOf({ outcomes: [outcome("o-1", [target("p-a"), target("p-b", { work: null })])] });
  assert.deepEqual(planWorkspaceDispatches(onlyB), [
    {
      key: `${workspaceId}:p-b:manager:outcome:o-1`,
      workspaceId,
      projectId: "p-b",
      role: "manager",
      subject: { kind: "outcome", id: "o-1" },
      reason: "Target Project has no Story for the Outcome",
    },
  ]);
  // 両方未分解ならA・Bそれぞれのmanager。StoryだけでTaskが無いProjectも未分解とみなす。
  const both = stateOf({
    outcomes: [outcome("o-1", [target("p-a", { work: null }), target("p-b", { work: { state: "incomplete", storyCount: 1, taskCount: 0 } })])],
  });
  assert.deepEqual(roles(both), ["manager@p-a:outcome:o-1", "manager@p-b:outcome:o-1"]);
  // 全Targetが分解済みで実行中なら何も起動しない（Worker / ReviewerはRalphの責務）。
  assert.deepEqual(roles(stateOf({ outcomes: [outcome("o-1", [target("p-a"), target("p-b")])] })), []);
});

test("全Targetが還流しincompleteが無いときだけEvaluatorを起動し、一部のProjectの完了では起動しない", () => {
  const partial = stateOf({ outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-b")])] });
  assert.equal(partial.outcomes[0]!.evaluability.status, "awaiting_execution");
  assert.deepEqual(roles(partial), []);
  const incomplete = stateOf({
    outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-b", { execution: { state: "incomplete", executionCursor: 3 } })])],
  });
  assert.deepEqual(roles(incomplete), []);

  const all = stateOf({ outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-b", { execution: done(7) })])] });
  const [evaluator, ...rest] = planWorkspaceDispatches(all);
  assert.equal(rest.length, 0);
  assert.equal(evaluator!.role, "evaluator");
  assert.equal(evaluator!.projectId, null);
  assert.ok(evaluator!.key.startsWith(`${workspaceId}:evaluator:outcome:o-1:`));
  assert.equal(planWorkspaceDispatches({ ...all, observedAt: 999 })[0]!.key, evaluator!.key, "同じ状態からは同じkey");
});

test("評価済みの還流では再評価せず、判断待ちのEvaluationはStrategistへ、還流が進めば別のkeyで再評価する", () => {
  const targets = [target("p-a", { execution: done(10) }), target("p-b", { execution: done(7) })];
  const evaluation = {
    id: "e-1",
    decisionId: null,
    createdAt: 1,
    targets: [
      { projectId: "p-a", executionCursor: 10 },
      { projectId: "p-b", executionCursor: 7 },
    ],
  };
  const evaluated = stateOf({ outcomes: [outcome("o-1", targets, { latestEvaluation: evaluation })] });
  assert.deepEqual(roles(evaluated), ["strategist:evaluation:e-1"]);
  assert.equal(planWorkspaceDispatches(evaluated)[0]!.key, `${workspaceId}:strategist:evaluation:e-1`);

  const before = planWorkspaceDispatches(stateOf({ outcomes: [outcome("o-1", targets)] }))[0]!.key;
  const advanced = stateOf({
    outcomes: [outcome("o-1", [targets[0]!, target("p-b", { execution: done(9) })], { latestEvaluation: evaluation })],
  });
  assert.deepEqual(roles(advanced).sort(), ["evaluator:outcome:o-1", "strategist:evaluation:e-1"]);
  assert.notEqual(planWorkspaceDispatches(advanced).find(({ role }) => role === "evaluator")!.key, before);

  // 判断済みのEvaluationのOutcomeは進行中とみなさず、次の判断が無ければIntentをStrategistへ戻す。
  const decided = stateOf({ outcomes: [outcome("o-1", targets, { latestEvaluation: { ...evaluation, decisionId: "d-1" } })] });
  assert.deepEqual(roles(decided), ["strategist:intent:i-1"]);
});

test("archivedのTargetに未還流・incompleteが残れば、別のactive TargetがあってもStrategistへ再計画を渡し、archivedのmanagerは起動しない", () => {
  const unreflected = stateOf({
    outcomes: [
      outcome("o-1", [
        target("p-a", { execution: done(10) }),
        target("p-b", { projectStatus: "archived", work: null }),
        target("p-c", { work: null }),
      ]),
    ],
  });
  assert.equal(unreflected.outcomes[0]!.evaluability.status, "replan_required");
  // p-cはactiveで未分解のためmanagerを起動する。p-bはarchivedのためmanagerを起動しない。
  assert.deepEqual(roles(unreflected), ["strategist:outcome:o-1", "manager@p-c:outcome:o-1"]);
  const replan = planWorkspaceDispatches(unreflected)[0]!;
  assert.equal(replan.projectId, null);
  assert.match(replan.key, new RegExp(`^${workspaceId}:strategist:outcome:o-1:replan:`));
  assert.match(replan.reason, /p-b/);

  // 還流済みでもincompleteのままarchiveされたTargetも再計画の対象。
  const incomplete = stateOf({
    outcomes: [
      outcome("o-1", [
        target("p-a"),
        target("p-b", { projectStatus: "archived", execution: { state: "incomplete", executionCursor: 4 } }),
      ]),
    ],
  });
  assert.deepEqual(roles(incomplete), ["strategist:outcome:o-1"]);
});

test("archive前に全Targetが還流を終えていれば、archivedのTargetを含めてEvaluatorへ進める", () => {
  const state = stateOf({
    projects: [{ id: "p-a", name: "A" }],
    outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-b", { projectStatus: "archived", execution: done(6) })])],
  });
  assert.equal(state.outcomes[0]!.evaluability.status, "evaluable");
  assert.deepEqual(roles(state), ["evaluator:outcome:o-1"]);
});

test("Researchの要否はStrategistが判断し、未終了のResearchはWorkspaceのResearcherへ渡す", () => {
  assert.deepEqual(roles(stateOf()), ["strategist:intent:i-1"]);
  assert.ok(planWorkspaceDispatches(stateOf())[0]!.key.startsWith(`${workspaceId}:strategist:intent:i-1:`));
  const open = research("r-1", "requested");
  const researching = stateOf({ openResearchRequests: [open], intentResearchRequests: [open] });
  assert.deepEqual(roles(researching), ["researcher:research_request:r-1"]);
  assert.equal(planWorkspaceDispatches(researching)[0]!.key, `${workspaceId}:researcher:research_request:r-1`);
  // Researchが終われば、別のkeyでIntentをStrategistへ戻す。
  const closed = planWorkspaceDispatches(stateOf({ intentResearchRequests: [research("r-1", "completed")] }))[0]!;
  assert.equal(closed.role, "strategist");
  assert.notEqual(closed.key, planWorkspaceDispatches(stateOf())[0]!.key);
});

test("archivedのWorkspaceでは何も起動せず、Active Intentが無ければResearcherだけを起動する", () => {
  assert.deepEqual(
    planWorkspaceDispatches(stateOf({ workspace: { id: workspaceId, name: "Workspace", status: "archived" }, outcomes: [outcome("o-1", [])] })),
    [],
  );
  const watch = { ...research("r-2", "running"), kind: "project_watch", originIntentId: null };
  assert.deepEqual(roles(stateOf({ activeIntent: null, openResearchRequests: [watch] })), ["researcher:research_request:r-2"]);
  assert.deepEqual(roles(stateOf({ activeIntent: null })), []);
});

test("再計画後の状態から次のRoleを起動し、同じ状態ではdispatch記録で重複起動しない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-plan-"));
  try {
    const policy = { leaseMs: 1000, maxAttempts: 3, retryBackoffMs: 100, terminateGraceMs: 500 };
    const store = new DispatchStore(directory);
    let now = 0;
    /** Orchestratorの1周と同じ手順（計画・古い記録の整理・起動判断）で、起動したAgentはすぐ成功したとみなす。 */
    const tick = (state: WorkspaceOrchestrationState) => {
      const planned = planWorkspaceDispatches(state);
      store.prune(workspaceId, planned);
      const launched: WorkspaceDispatch[] = [];
      for (const dispatch of planned) {
        const decision = decideLaunch(store.get(dispatch.key), now, policy);
        if (!decision.launch) continue;
        store.set(dispatch.key, finishRecord(decision.attempt, { ok: true }, (now += 1), policy));
        launched.push(dispatch);
      }
      return launched.map(({ role, projectId, subject }) => `${role}${projectId ? `@${projectId}` : ""}:${subject.kind}:${subject.id}`);
    };

    // A完了・Bがarchive前に未還流 → Strategistへ再計画。
    const stuck = stateOf({
      projects: [
        { id: "p-a", name: "A" },
        { id: "p-c", name: "C" },
      ],
      outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-b", { projectStatus: "archived" })])],
    });
    assert.deepEqual(tick(stuck), ["strategist:outcome:o-1"]);
    // Strategistが何も変えずに終えた（同じ状態）、Orchestratorの再起動後の観測（同じ記録）でも再起動しない。
    assert.deepEqual(tick({ ...stuck, observedAt: 50 }), []);
    assert.deepEqual(tick(stuck), []);

    // StrategistがBを解除しCを追加した → Cのmanagerだけ。
    const replanned = stateOf({
      projects: stuck.projects,
      outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-c", { work: null })])],
    });
    assert.deepEqual(tick(replanned), ["manager@p-c:outcome:o-1"]);
    assert.deepEqual(tick(replanned), []);

    // Cも還流前にarchiveされた → 新しい状態として再びStrategistへ再計画（前回の再計画とは別のkey）。
    const stuckAgain = stateOf({
      projects: [{ id: "p-a", name: "A" }],
      outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-c", { projectStatus: "archived" })])],
    });
    assert.deepEqual(tick(stuckAgain), ["strategist:outcome:o-1"]);

    // Cの還流で全Targetが終わる → Evaluator。同じ還流では再評価しない。
    const finished = stateOf({
      projects: [{ id: "p-a", name: "A" }],
      outcomes: [outcome("o-1", [target("p-a", { execution: done(10) }), target("p-c", { projectStatus: "archived", execution: done(5) })])],
    });
    assert.deepEqual(tick(finished), ["evaluator:outcome:o-1"]);
    assert.deepEqual(tick(finished), []);
    // 計画から消えたkey（再計画・manager）の記録は捨て、現在の計画のkeyだけを残す。
    assert.deepEqual(Object.keys(store.all()), planWorkspaceDispatches(finished).map(({ key }) => key));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
