import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompassStateReader } from "../src/compassClient.ts";
import type { OrchestratorConfig, RoleCommand } from "../src/config.ts";
import { DispatchStore } from "../src/dispatchStore.ts";
import type { AgentLauncher, LaunchResult } from "../src/launcher.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { WorkspaceDispatch } from "../src/plan.ts";
import type { WorkspaceOrchestrationOutcome, WorkspaceOrchestrationState } from "../src/state.ts";

const baseState = (workspaceId: string): WorkspaceOrchestrationState => ({
  workspace: { id: workspaceId, name: workspaceId, status: "active" },
  projects: [],
  activeIntent: { id: `${workspaceId}-intent`, status: "active", updatedAt: 1 },
  outcomes: [],
  intentResearchRequests: [],
  openResearchRequests: [],
  observedAt: 1,
});

/** Target A / B の Story が無い（未分解の）進行中の Outcome。 */
const undecomposed = (id: string, projectIds: string[]): WorkspaceOrchestrationOutcome => ({
  id,
  status: "active",
  updatedAt: 1,
  targets: projectIds.map((projectId) => ({ projectId, projectStatus: "active", work: null, execution: null })),
  evaluability: {
    status: "awaiting_execution",
    unfinishedTargets: projectIds.map((projectId) => ({ projectId, projectStatus: "active", reason: "not_reflected" })),
  },
  latestEvaluation: null,
});

/** 起動を記録し、テストが結果を確定させるまで終わらないAgent。 */
class FakeLauncher implements AgentLauncher {
  readonly launches: { dispatch: WorkspaceDispatch; command: RoleCommand; attempt: number; finish: (result: LaunchResult) => void }[] = [];
  launch(dispatch: WorkspaceDispatch, command: RoleCommand, context: { attempt: number }) {
    let finish!: (result: LaunchResult) => void;
    const done = new Promise<LaunchResult>((resolve) => (finish = resolve));
    this.launches.push({ dispatch, command, attempt: context.attempt, finish });
    return { pid: null, done, start: () => {} };
  }
}

const setup = async (overrides: Partial<OrchestratorConfig> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-"));
  const states = new Map<string, WorkspaceOrchestrationState | Error>([["w-1", baseState("w-1")]]);
  const reader: CompassStateReader = {
    getWorkspaceOrchestrationState: async (workspaceId) => {
      const state = states.get(workspaceId);
      if (state instanceof Error) throw state;
      return state!;
    },
  };
  const clock = { now: 1_000 };
  const config: OrchestratorConfig = {
    serverUrl: "http://127.0.0.1:1",
    stateDir: directory,
    intervalMs: 1000,
    leaseMs: 10_000,
    maxAttempts: 2,
    retryBackoffMs: 500,
    maxConcurrent: 5,
    terminateGraceMs: 1_000,
    workspaces: [{ workspaceId: "w-1", tokenEnv: "RUNTIME_TOKEN", token: "runtime-1", agentEnv: {}, projects: [] }],
    roles: { strategist: { command: "true", env: {} }, researcher: { command: "true", env: {} } },
    ...overrides,
  };
  const launcher = new FakeLauncher();
  const create = () => new Orchestrator(config, reader, launcher, new DispatchStore(directory), () => clock.now, () => undefined);
  return { directory, states, clock, launcher, create, cleanup: () => rm(directory, { recursive: true, force: true }) };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("同じ状態では実行中・成功後とも再起動せず、状態が進めば新しい対象を起動する", async () => {
  const kit = await setup();
  try {
    const orchestrator = kit.create();
    const first = await orchestrator.tick();
    assert.deepEqual(first.launched.map(({ role }) => role), ["strategist"]);
    // 実行中の再観測（並行起動・polling）では起動しない。
    assert.equal((await orchestrator.tick()).launched.length, 0);
    // Orchestratorを作り直しても（同じstore）、生存中の実行は重複させない。
    assert.equal((await kit.create().tick()).launched.length, 0);

    kit.launcher.launches[0]!.finish({ ok: true });
    await orchestrator.drain();
    // Strategistが状態を変えずに終えた場合も、同じ状態では再起動しない。
    assert.equal((await orchestrator.tick()).launched.length, 0);

    // StrategistがResearchを依頼した: Researcherだけを起動する。
    const request = { id: "r-1", kind: "decision", status: "requested", originIntentId: "w-1-intent", originOutcomeId: null, updatedAt: 2 };
    kit.states.set("w-1", { ...baseState("w-1"), openResearchRequests: [request], intentResearchRequests: [request] });
    assert.deepEqual((await orchestrator.tick()).launched.map(({ role }) => role), ["researcher"]);
    // 状態が進んで計画から消えた成功記録は捨てる（Strategistの古いkey）。
    const store = new DispatchStore(kit.directory);
    assert.deepEqual(Object.keys(store.all()), ["w-1:researcher:research_request:r-1"]);
    kit.launcher.launches[1]!.finish({ ok: true });
    await orchestrator.drain();
  } finally {
    await kit.cleanup();
  }
});

test("失敗はbackoff後に再試行し、上限に達したら同じ状態では起動しない", async () => {
  const kit = await setup();
  try {
    const orchestrator = kit.create();
    await orchestrator.tick();
    kit.launcher.launches[0]!.finish({ ok: false, error: "exited with code 1" });
    await orchestrator.drain();
    assert.equal((await orchestrator.tick()).skipped[0]!.reason, "waiting for retry backoff");
    kit.clock.now += 500;
    const retried = await orchestrator.tick();
    assert.equal(retried.launched.length, 1);
    assert.equal(kit.launcher.launches[1]!.attempt, 2);
    kit.launcher.launches[1]!.finish({ ok: false, error: "exited with code 1" });
    await orchestrator.drain();
    kit.clock.now += 10_000;
    const gaveUp = await orchestrator.tick();
    assert.equal(gaveUp.launched.length, 0);
    assert.match(gaveUp.skipped[0]!.reason, /gave up after 2 attempts/);
  } finally {
    await kit.cleanup();
  }
});

test("lease切れの実行は回収して再試行し、Roleのコマンドが無い対象は起動も記録もしない", async () => {
  const kit = await setup();
  try {
    const orchestrator = kit.create();
    await orchestrator.tick();
    // 別インスタンス（再起動後）から見て、lease切れの実行は次の試行として起動する。
    kit.clock.now += 10_000;
    const restarted = kit.create();
    const recovered = await restarted.tick();
    assert.equal(recovered.launched.length, 1);
    assert.equal(kit.launcher.launches[1]!.attempt, 2);
    for (const launch of kit.launcher.launches) launch.finish({ ok: true });
    await orchestrator.drain();
    await restarted.drain();

    kit.states.set("w-1", { ...baseState("w-1"), outcomes: [undecomposed("o-1", ["p-a"])] });
    const unconfigured = await restarted.tick();
    assert.equal(unconfigured.launched.length, 0);
    assert.equal(unconfigured.skipped[0]!.reason, "no command is configured for the manager Role");
    assert.equal(new DispatchStore(kit.directory).get("w-1:p-a:manager:outcome:o-1"), undefined);
  } finally {
    await kit.cleanup();
  }
});

test("状態を読めないWorkspaceは他のWorkspaceの起動を妨げず、記録も消さない", async () => {
  const workspace = (workspaceId: string) => ({ workspaceId, tokenEnv: "T", token: "t", agentEnv: {}, projects: [] });
  const kit = await setup({ workspaces: [workspace("w-1"), workspace("w-2")] });
  try {
    kit.states.set("w-2", baseState("w-2"));
    const orchestrator = kit.create();
    await orchestrator.tick();
    for (const launch of kit.launcher.launches) launch.finish({ ok: true });
    await orchestrator.drain();

    kit.states.set("w-1", new Error("FORBIDDEN"));
    kit.states.set("w-2", { ...baseState("w-2"), activeIntent: null });
    const report = await orchestrator.tick();
    assert.deepEqual(report.failedWorkspaces, [{ workspaceId: "w-1", error: "FORBIDDEN" }]);
    const keys = Object.keys(new DispatchStore(kit.directory).all());
    assert.equal(keys.length, 1);
    assert.ok(keys[0]!.startsWith("w-1:strategist:intent:"));
  } finally {
    await kit.cleanup();
  }
});

test("同時起動数の上限を超える対象は次の周回へ回す", async () => {
  const kit = await setup({ maxConcurrent: 1 });
  try {
    const requests = ["r-1", "r-2"].map((id) => ({ id, kind: "decision", status: "requested", originIntentId: "w-1-intent", originOutcomeId: null, updatedAt: 1 }));
    kit.states.set("w-1", { ...baseState("w-1"), openResearchRequests: requests, intentResearchRequests: requests });
    const orchestrator = kit.create();
    const first = await orchestrator.tick();
    assert.equal(first.launched.length, 1);
    assert.equal(first.skipped[0]!.reason, "max concurrent launches reached");
    kit.launcher.launches[0]!.finish({ ok: true });
    await settle();
    await orchestrator.drain();
    assert.equal((await orchestrator.tick()).launched.length, 1);
    kit.launcher.launches[1]!.finish({ ok: true });
    await orchestrator.drain();
  } finally {
    await kit.cleanup();
  }
});

test("Workspace RoleにはWorkspaceのagentEnv、managerにはTarget ProjectのagentEnvを渡し、設定に無いProjectのmanagerは起動も記録もしない", async () => {
  const kit = await setup({
    workspaces: [
      {
        workspaceId: "w-1",
        tokenEnv: "RUNTIME_TOKEN",
        token: "runtime-1",
        agentEnv: { AGENT_MCP_CONFIG: "/etc/w-1-direction.json" },
        projects: [{ projectId: "p-a", agentEnv: { AGENT_MCP_CONFIG: "/etc/p-a-manager.json" } }],
      },
    ],
    roles: {
      strategist: { command: "true", env: { ROLE: "strategist" } },
      manager: { command: "true", env: { ROLE: "manager" } },
    },
  });
  try {
    const request = { id: "r-1", kind: "decision", status: "requested", originIntentId: "w-1-intent", originOutcomeId: null, updatedAt: 1 };
    kit.states.set("w-1", {
      ...baseState("w-1"),
      // 未分解の Outcome の Target A / B と、判断待ちの Evaluation（Strategist）。researcher のコマンドは無い。
      outcomes: [
        undecomposed("o-1", ["p-a", "p-b"]),
        { ...undecomposed("o-2", []), status: "achieved", latestEvaluation: { id: "e-1", decisionId: null, createdAt: 1, targets: [] } },
      ],
      openResearchRequests: [request],
    });
    const orchestrator = kit.create();
    const report = await orchestrator.tick();
    const launched = kit.launcher.launches.map(({ dispatch, command }) => [dispatch.key, command.env]);
    assert.deepEqual(launched, [
      ["w-1:p-a:manager:outcome:o-1", { ROLE: "manager", AGENT_MCP_CONFIG: "/etc/p-a-manager.json" }],
      ["w-1:strategist:evaluation:e-1", { ROLE: "strategist", AGENT_MCP_CONFIG: "/etc/w-1-direction.json" }],
    ]);
    assert.deepEqual(
      report.skipped.map(({ key, reason }) => [key, reason]),
      [
        ["w-1:researcher:research_request:r-1", "no command is configured for the researcher Role"],
        ["w-1:p-b:manager:outcome:o-1", "Project p-b is not configured in workspaces[].projects"],
      ],
    );
    assert.equal(new DispatchStore(kit.directory).get("w-1:p-b:manager:outcome:o-1"), undefined);
    for (const launch of kit.launcher.launches) launch.finish({ ok: true });
    await orchestrator.drain();
  } finally {
    await kit.cleanup();
  }
});

test("Project相談はWorkspace dispatchなしで入力版ごとにManagerを起動し、未処理の正常終了を再試行する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-consultation-dispatch-"));
  let revision = 2;
  let pending = true;
  let now = 1_000;
  const reader: CompassStateReader = {
    getWorkspaceOrchestrationState: async () => assert.fail("Workspace dispatchをGivenに要求しない"),
    getProjectConsultationState: async (projectId, token) => {
      assert.equal(projectId, "p1"); assert.equal(token, "project-runtime");
      return { workspaceId: "w1", projectId, projectStatus: "active", consultations: pending ? [{ id: "c1", inputRevision: revision }] : [], observedAt: now };
    },
  };
  const launcher = new FakeLauncher();
  const config: OrchestratorConfig = { serverUrl: "http://localhost:1", stateDir: directory, intervalMs: 1000,
    leaseMs: 10000, maxAttempts: 3, retryBackoffMs: 100, maxConcurrent: 2, terminateGraceMs: 100,
    workspaces: [], consultationProjects: [{ projectId: "p1", tokenEnv: "P_RUNTIME", token: "project-runtime", agentEnv: { MANAGER_CONFIG: "project-specific" } }],
    roles: { manager: { command: "manager", env: {} } } };
  const store = new DispatchStore(directory);
  const runner = new Orchestrator(config, reader, launcher, store, () => now, () => {});
  try {
    const first = await runner.tick();
    assert.equal(first.launched[0]?.subject.inputRevision, 2);
    assert.equal(launcher.launches[0]?.command.env.MANAGER_CONFIG, "project-specific");
    assert.equal((await runner.tick()).launched.length, 0);
    launcher.launches[0]!.finish({ ok: true });
    await runner.drain();
    assert.equal(store.get(first.launched[0]!.key)?.status, "retry_wait");
    now += 101;
    assert.equal((await runner.tick()).launched.length, 1);
    revision = 3; // 応答中のHuman追加返信は独立した新しい入力版。
    launcher.launches[1]!.finish({ ok: false, error: "STALE_REVISION" });
    await runner.drain();
    assert.equal((await runner.tick()).launched[0]?.subject.inputRevision, 3);
    pending = false;
    launcher.launches[2]!.finish({ ok: true });
    await runner.drain();
    assert.equal((await runner.tick()).launched.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Workspace相談は同じWorkspace Runtime Credentialで読み、入力版ごとにStrategistを起動し、未処理の正常終了と読取り失敗を処理済みにしない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-consultation-dispatch-"));
  let revision = 2;
  let pending = true;
  let failRead = false;
  let workspaceStatus = "active";
  const now = 1_000;
  const reader: CompassStateReader = {
    getWorkspaceOrchestrationState: async (workspaceId) => ({ ...baseState(workspaceId), activeIntent: null }),
    getWorkspaceConsultationState: async (workspaceId, token) => {
      assert.equal(workspaceId, "w-1"); assert.equal(token, "runtime-1");
      if (failRead) throw new Error("FORBIDDEN");
      return { workspaceId, workspaceStatus, consultations: pending ? [{ id: "wc1", inputRevision: revision }] : [], observedAt: now };
    },
  };
  const launcher = new FakeLauncher();
  const config: OrchestratorConfig = { serverUrl: "http://localhost:1", stateDir: directory, intervalMs: 1000,
    leaseMs: 10000, maxAttempts: 3, retryBackoffMs: 100, maxConcurrent: 2, terminateGraceMs: 100,
    workspaces: [{ workspaceId: "w-1", tokenEnv: "RUNTIME_TOKEN", token: "runtime-1", agentEnv: { STRATEGIST_CONFIG: "workspace-specific" }, projects: [] }],
    roles: { strategist: { command: "strategist", env: {} } } };
  const store = new DispatchStore(directory);
  const runner = new Orchestrator(config, reader, launcher, store, () => now, () => {});
  try {
    const first = await runner.tick();
    assert.equal(first.launched.length, 1);
    const dispatch = first.launched[0]!;
    assert.equal(dispatch.key, "w-1:strategist:consultation:wc1:2");
    assert.equal(dispatch.role, "strategist");
    assert.equal(dispatch.projectId, null);
    assert.deepEqual(dispatch.subject, { kind: "consultation", id: "wc1", inputRevision: 2 });
    assert.equal(launcher.launches[0]?.command.env.STRATEGIST_CONFIG, "workspace-specific");
    // 正常終了しても同じ入力版が未処理なら再試行待ち。
    launcher.launches[0]!.finish({ ok: true });
    await runner.drain();
    assert.equal(store.get(dispatch.key)?.status, "retry_wait");
    // 状態を読めない周回は失敗として報告し、記録を消さない。
    failRead = true;
    const failed = await runner.tick();
    assert.deepEqual(failed.failedWorkspaces.map(({ workspaceId }) => workspaceId), ["w-1"]);
    assert.equal(store.get(dispatch.key)?.status, "retry_wait");
    failRead = false;
    // Humanの追加返信は新しい入力版。応答で処理されれば再起動しない。
    revision = 3;
    const next = await runner.tick();
    assert.equal(next.launched[0]?.key, "w-1:strategist:consultation:wc1:3");
    pending = false;
    launcher.launches[1]!.finish({ ok: true });
    await runner.drain();
    assert.equal(store.get("w-1:strategist:consultation:wc1:3")?.status, "succeeded");
    assert.equal((await runner.tick()).launched.length, 0);
    // archivedのWorkspaceでは起動しない。
    pending = true; revision = 4; workspaceStatus = "archived";
    assert.equal((await runner.tick()).launched.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
