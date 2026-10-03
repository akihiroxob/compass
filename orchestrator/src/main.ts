import { parseArgs } from "node:util";
import { McpCompassStateReader } from "./compassClient.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { acquireProcessLock, DispatchStore } from "./dispatchStore.ts";
import { ShellAgentLauncher } from "./launcher.ts";
import { jsonLog, Orchestrator } from "./orchestrator.ts";

const usage = "Usage: npm run start --workspace orchestrator -- --config <path> [--once]";

const main = async () => {
  const { values } = parseArgs({
    options: { config: { type: "string" }, once: { type: "boolean", default: false } },
  });
  const configPath = values.config ?? process.env.COMPASS_ORCHESTRATOR_CONFIG;
  if (!configPath) throw new ConfigError(`--config or COMPASS_ORCHESTRATOR_CONFIG is required. ${usage}`);
  const config = loadConfig(configPath);
  const release = acquireProcessLock(config.stateDir);
  const orchestrator = new Orchestrator(
    config,
    new McpCompassStateReader(config.serverUrl),
    new ShellAgentLauncher(),
    new DispatchStore(config.stateDir),
  );
  try {
    if (values.once) {
      await orchestrator.tick();
      await orchestrator.drain();
      return;
    }
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    jsonLog("orchestrator_started", { projects: config.projects.map(({ projectId }) => projectId), intervalMs: config.intervalMs });
    while (!stopping) {
      await orchestrator.tick();
      const deadline = Date.now() + config.intervalMs;
      while (!stopping && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, config.intervalMs)));
    }
    // 起動済みの Agent は終わるまで待つ（停止させない）。
    await orchestrator.drain();
  } finally {
    release();
  }
};

main().catch((error: unknown) => {
  jsonLog("orchestrator_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
