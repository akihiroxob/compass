import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { isAgentAlive } from "../src/dispatchStore.ts";
import { buildAgentEnv, ShellAgentLauncher } from "../src/launcher.ts";
import type { Dispatch } from "../src/plan.ts";

const dispatch: Dispatch = {
  key: "p-1:strategist:intent:i-1",
  projectId: "p-1",
  role: "strategist",
  subject: { kind: "intent", id: "i-1" },
  reason: "active intent",
};

test("Agentの環境変数からはすべてのProjectのRuntime Credentialを除き、Roleのenvと対象だけを加える", () => {
  const env = buildAgentEnv(
    { PATH: "/bin", REVIEW_RUNTIME_TOKEN: "marker", OTHER_PROJECT_TOKEN: "marker-2" },
    ["REVIEW_RUNTIME_TOKEN", "OTHER_PROJECT_TOKEN"],
    dispatch,
    { command: "true", env: { ROLE_MCP_CONFIG: "/etc/strategist.json" } },
    { serverUrl: "http://127.0.0.1:1", attempt: 1 },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ROLE_MCP_CONFIG, "/etc/strategist.json");
  assert.equal(env.COMPASS_ROLE, "strategist");
  assert.equal(Object.hasOwn(env, "REVIEW_RUNTIME_TOKEN"), false);
  assert.equal(Object.hasOwn(env, "OTHER_PROJECT_TOKEN"), false);
});

test("ShellAgentLauncherで起動した子プロセスはRuntime Credentialを読めない", async () => {
  const launcher = new ShellAgentLauncher({
    credentialEnv: ["REVIEW_RUNTIME_TOKEN"],
    terminateGraceMs: 100,
    parentEnv: { ...process.env, REVIEW_RUNTIME_TOKEN: "marker" },
  });
  const check = `"${process.execPath}" -e "process.exit(process.env.REVIEW_RUNTIME_TOKEN === undefined && process.env.COMPASS_ROLE === 'strategist' ? 0 : 3)"`;
  const result = await launcher.launch(dispatch, { command: check, env: {} }, { serverUrl: "http://127.0.0.1:1", attempt: 1, timeoutMs: 10_000 }).done;
  assert.deepEqual(result, { ok: true });
});

test("RoleのenvでRuntime Credentialの環境変数名を設定する構成は拒否する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-config-"));
  try {
    const path = join(directory, "orchestrator.json");
    await writeFile(
      path,
      JSON.stringify({
        serverUrl: "http://127.0.0.1:1",
        projects: [{ projectId: "p-1", tokenEnv: "RUNTIME_TOKEN" }],
        roles: { strategist: { command: "true", env: { RUNTIME_TOKEN: "x" } } },
      }),
    );
    assert.throws(() => loadConfig(path, { RUNTIME_TOKEN: "secret" }), (error: unknown) => error instanceof ConfigError && /RUNTIME_TOKEN/.test(error.message));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeoutしたAgentがSIGTERMで止まらなければ猶予後にSIGKILLし、停止を確認してから試行を終える", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-launcher-"));
  try {
    const sleepAgent = fileURLToPath(new URL("./support/sleepAgent.ts", import.meta.url));
    const launcher = new ShellAgentLauncher({ credentialEnv: [], terminateGraceMs: 300 });
    const launched = launcher.launch(
      dispatch,
      {
        command: `"${process.execPath}" --import "${import.meta.resolve("tsx")}" "${sleepAgent}"`,
        env: { SLEEP_AGENT_LOG: join(directory, "agents.jsonl"), SLEEP_AGENT_MS: "60000", SLEEP_AGENT_IGNORE_SIGTERM: "1" },
      },
      { serverUrl: "http://127.0.0.1:1", attempt: 1, timeoutMs: 1500 },
    );
    const result = await launched.done;
    assert.deepEqual(result, { ok: false, error: "timed out after 1500ms" });
    assert.equal(isAgentAlive(launched.pid!), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
