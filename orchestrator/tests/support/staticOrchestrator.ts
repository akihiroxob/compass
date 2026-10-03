import { loadConfig } from "../../src/config.ts";
import { acquireProcessLock, DispatchStore, type DispatchRecord } from "../../src/dispatchStore.ts";
import { ShellAgentLauncher } from "../../src/launcher.ts";
import { Orchestrator } from "../../src/orchestrator.ts";
import type { OrchestrationState } from "../../src/state.ts";

/**
 * Server を使わずに Orchestrator を実プロセスとして動かすテスト用の起動口。状態は固定の Active Intent だけで、
 * 設定・Credential の解決、process lock、起動記録、Agent の起動・停止は本番と同じ実装を使う。
 * `STATIC_ORCHESTRATOR_CRASH_BEFORE_PID=1` では、Agent を spawn した後・PID を記録する前に自身を SIGKILL する（停止窓の再現）。
 * `--once` は1周して起動した Agent の終了を待つ。省略時は停止されるまで1秒ごとに周回する。
 */
class CrashBeforePidStore extends DispatchStore {
  override set(key: string, record: DispatchRecord): void {
    if (record.status === "running" && record.childPid !== null) process.kill(process.pid, "SIGKILL");
    super.set(key, record);
  }
}

const [configPath, mode] = process.argv.slice(2);
const config = loadConfig(configPath!);
const release = acquireProcessLock(config.stateDir);
const state = (projectId: string): OrchestrationState => ({
  project: { id: projectId, name: projectId, status: "active" },
  activeIntent: { id: `${projectId}-intent`, status: "active", updatedAt: 1 },
  outcomes: [],
  intentResearchRequests: [],
  openResearchRequests: [],
  observedAt: 1,
});
const orchestrator = new Orchestrator(
  config,
  { getOrchestrationState: async (projectId) => state(projectId) },
  new ShellAgentLauncher({ credentialEnv: config.projects.map(({ tokenEnv }) => tokenEnv), terminateGraceMs: config.terminateGraceMs }),
  process.env.STATIC_ORCHESTRATOR_CRASH_BEFORE_PID === "1" ? new CrashBeforePidStore(config.stateDir) : new DispatchStore(config.stateDir),
);
try {
  if (mode === "--once") {
    await orchestrator.tick();
    await orchestrator.drain();
  } else {
    for (;;) {
      await orchestrator.tick();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
} finally {
  release();
}
