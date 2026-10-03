import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompassStateReader } from "../src/compassClient.ts";
import type { OrchestratorConfig } from "../src/config.ts";
import { DispatchStore } from "../src/dispatchStore.ts";
import type { AgentLauncher, LaunchResult } from "../src/launcher.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { Dispatch } from "../src/plan.ts";
import type { OrchestrationState } from "../src/state.ts";

const baseState = (projectId: string): OrchestrationState => ({
  project: { id: projectId, name: projectId, status: "active" },
  activeIntent: { id: `${projectId}-intent`, status: "active", updatedAt: 1 },
  outcomes: [],
  intentResearchRequests: [],
  openResearchRequests: [],
  observedAt: 1,
});

/** 起動を記録し、テストが結果を確定させるまで終わらないAgent。 */
class FakeLauncher implements AgentLauncher {
  readonly launches: { dispatch: Dispatch; attempt: number; finish: (result: LaunchResult) => void }[] = [];
  launch(dispatch: Dispatch, _command: unknown, context: { attempt: number }) {
    let finish!: (result: LaunchResult) => void;
    const done = new Promise<LaunchResult>((resolve) => (finish = resolve));
    this.launches.push({ dispatch, attempt: context.attempt, finish });
    return { pid: null, done };
  }
}

const setup = async (overrides: Partial<OrchestratorConfig> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-"));
  const states = new Map<string, OrchestrationState | Error>([["p-1", baseState("p-1")]]);
  const reader: CompassStateReader = {
    getOrchestrationState: async (projectId) => {
      const state = states.get(projectId);
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
    projects: [{ projectId: "p-1", tokenEnv: "RUNTIME_TOKEN", token: "runtime-1" }],
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
    const request = { id: "r-1", kind: "decision", status: "requested", originIntentId: "p-1-intent", originOutcomeId: null, updatedAt: 2 };
    kit.states.set("p-1", { ...baseState("p-1"), openResearchRequests: [request], intentResearchRequests: [request] });
    assert.deepEqual((await orchestrator.tick()).launched.map(({ role }) => role), ["researcher"]);
    // 状態が進んで計画から消えた成功記録は捨てる（Strategistの古いkey）。
    const store = new DispatchStore(kit.directory);
    assert.deepEqual(Object.keys(store.all()), ["p-1:researcher:research_request:r-1"]);
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

    kit.states.set("p-1", { ...baseState("p-1"), outcomes: [{ id: "o-1", status: "active", updatedAt: 1, work: null, execution: null, latestEvaluation: null }] });
    const unconfigured = await restarted.tick();
    assert.equal(unconfigured.launched.length, 0);
    assert.equal(unconfigured.skipped[0]!.reason, "no command is configured for the manager Role");
    assert.equal(new DispatchStore(kit.directory).get("p-1:manager:outcome:o-1"), undefined);
  } finally {
    await kit.cleanup();
  }
});

test("状態を読めないProjectは他のProjectの起動を妨げず、記録も消さない", async () => {
  const kit = await setup({ projects: [{ projectId: "p-1", tokenEnv: "T", token: "t" }, { projectId: "p-2", tokenEnv: "T", token: "t" }] });
  try {
    kit.states.set("p-2", baseState("p-2"));
    const orchestrator = kit.create();
    await orchestrator.tick();
    for (const launch of kit.launcher.launches) launch.finish({ ok: true });
    await orchestrator.drain();

    kit.states.set("p-1", new Error("FORBIDDEN"));
    kit.states.set("p-2", { ...baseState("p-2"), activeIntent: null });
    const report = await orchestrator.tick();
    assert.deepEqual(report.failedProjects, [{ projectId: "p-1", error: "FORBIDDEN" }]);
    const keys = Object.keys(new DispatchStore(kit.directory).all());
    assert.equal(keys.length, 1);
    assert.ok(keys[0]!.startsWith("p-1:strategist:intent:"));
  } finally {
    await kit.cleanup();
  }
});

test("同時起動数の上限を超える対象は次の周回へ回す", async () => {
  const kit = await setup({ maxConcurrent: 1 });
  try {
    const requests = ["r-1", "r-2"].map((id) => ({ id, kind: "decision", status: "requested", originIntentId: "p-1-intent", originOutcomeId: null, updatedAt: 1 }));
    kit.states.set("p-1", { ...baseState("p-1"), openResearchRequests: requests, intentResearchRequests: requests });
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
