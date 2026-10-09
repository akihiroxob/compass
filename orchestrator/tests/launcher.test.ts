import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { isAgentAlive } from "../src/dispatchStore.ts";
import { buildAgentEnv, buildPrompt, ShellAgentLauncher } from "../src/launcher.ts";
import type { WorkspaceDispatch } from "../src/plan.ts";

const dispatch: WorkspaceDispatch = {
  key: "w-1:strategist:intent:i-1:v",
  workspaceId: "w-1",
  projectId: null,
  role: "strategist",
  subject: { kind: "intent", id: "i-1" },
  reason: "active intent",
};

const managerDispatch: WorkspaceDispatch = {
  key: "w-1:p-a:manager:outcome:o-1",
  workspaceId: "w-1",
  projectId: "p-a",
  role: "manager",
  subject: { kind: "outcome", id: "o-1" },
  reason: "Target Project has no Story for the Outcome",
};

test("Agentの環境変数からはすべてのWorkspaceのRuntime Credentialを除き、Roleのenvと対象だけを加える", () => {
  const env = buildAgentEnv(
    { PATH: "/bin", REVIEW_RUNTIME_TOKEN: "marker", OTHER_WORKSPACE_TOKEN: "marker-2", COMPASS_PROJECT_ID: "inherited" },
    ["REVIEW_RUNTIME_TOKEN", "OTHER_WORKSPACE_TOKEN"],
    dispatch,
    { command: "true", env: { ROLE_MCP_CONFIG: "/etc/strategist.json", COMPASS_WORKSPACE_ID: "spoofed" } },
    { serverUrl: "http://127.0.0.1:1", attempt: 1 },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ROLE_MCP_CONFIG, "/etc/strategist.json");
  assert.equal(env.COMPASS_ROLE, "strategist");
  assert.equal(env.COMPASS_WORKSPACE_ID, "w-1");
  // Workspace RoleにはProject IDを渡さない（親の環境変数からも引き継がない）。
  assert.equal(Object.hasOwn(env, "COMPASS_PROJECT_ID"), false);
  assert.equal(Object.hasOwn(env, "REVIEW_RUNTIME_TOKEN"), false);
  assert.equal(Object.hasOwn(env, "OTHER_WORKSPACE_TOKEN"), false);
});

test("Workspace RoleはWorkspaceのRole Context、managerはTarget ProjectのRole Contextを取得するよう指示する", () => {
  const workspacePrompt = buildPrompt(dispatch);
  assert.match(workspacePrompt, /get_workspace_role_context\(\{ workspaceId: "w-1", role: "strategist" \}\)/);
  assert.doesNotMatch(workspacePrompt, /projectId/);
  const managerPrompt = buildPrompt(managerDispatch);
  assert.match(managerPrompt, /get_role_context\(\{ projectId: "p-a", role: "manager" \}\)/);
  assert.match(managerPrompt, /workspaceId: w-1/);
  const env = buildAgentEnv({}, [], managerDispatch, { command: "true", env: {} }, { serverUrl: "http://127.0.0.1:1", attempt: 2 });
  assert.equal(env.COMPASS_WORKSPACE_ID, "w-1");
  assert.equal(env.COMPASS_PROJECT_ID, "p-a");
  assert.equal(env.COMPASS_DISPATCH_KEY, "w-1:p-a:manager:outcome:o-1");
});

test("ShellAgentLauncherで起動した子プロセスはRuntime Credentialを読めない", async () => {
  const launcher = new ShellAgentLauncher({
    credentialEnv: ["REVIEW_RUNTIME_TOKEN"],
    terminateGraceMs: 100,
    parentEnv: { ...process.env, REVIEW_RUNTIME_TOKEN: "marker" },
  });
  const check = `"${process.execPath}" -e "process.exit(process.env.REVIEW_RUNTIME_TOKEN === undefined && process.env.COMPASS_ROLE === 'strategist' ? 0 : 3)"`;
  const launched = launcher.launch(dispatch, { command: check, env: {} }, { serverUrl: "http://127.0.0.1:1", attempt: 1, timeoutMs: 10_000 });
  launched.start();
  assert.deepEqual(await launched.done, { ok: true });
});

test("ShellAgentLauncherはstart()を呼ぶまでRoleのコマンドを実行しない", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-gate-"));
  try {
    const marker = join(directory, "started");
    const launcher = new ShellAgentLauncher({ credentialEnv: [], terminateGraceMs: 100 });
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1], '')" "${marker}"`;
    const launched = launcher.launch(dispatch, { command, env: {} }, { serverUrl: "http://127.0.0.1:1", attempt: 1, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(marker), false);
    assert.equal(isAgentAlive(launched.pid!), true, "the Agent waits for the start signal");
    launched.start();
    assert.deepEqual(await launched.done, { ok: true });
    assert.equal(existsSync(marker), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const withConfig = async (config: unknown, check: (path: string) => void) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-config-"));
  try {
    const path = join(directory, "orchestrator.json");
    await writeFile(path, JSON.stringify(config));
    check(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const configError = (pattern: RegExp) => (error: unknown) => error instanceof ConfigError && pattern.test(error.message);

test("RoleのenvやscopeのagentEnvでRuntime Credentialの環境変数名を設定する構成は拒否する", async () => {
  const workspace = { workspaceId: "w-1", tokenEnv: "RUNTIME_TOKEN" };
  await withConfig(
    { serverUrl: "http://127.0.0.1:1", workspaces: [workspace], roles: { strategist: { command: "true", env: { RUNTIME_TOKEN: "x" } } } },
    (path) => assert.throws(() => loadConfig(path, { RUNTIME_TOKEN: "secret" }), configError(/roles\.strategist\.env .*RUNTIME_TOKEN/)),
  );
  await withConfig(
    { serverUrl: "http://127.0.0.1:1", workspaces: [{ ...workspace, agentEnv: { RUNTIME_TOKEN: "x" } }], roles: {} },
    (path) => assert.throws(() => loadConfig(path, { RUNTIME_TOKEN: "secret" }), configError(/workspaces\[0\]\.agentEnv .*RUNTIME_TOKEN/)),
  );
  await withConfig(
    { serverUrl: "http://127.0.0.1:1", workspaces: [{ ...workspace, projects: [{ projectId: "p-a", agentEnv: { RUNTIME_TOKEN: "x" } }] }], roles: {} },
    (path) => assert.throws(() => loadConfig(path, { RUNTIME_TOKEN: "secret" }), configError(/workspaces\[0\]\.projects\[0\]\.agentEnv .*RUNTIME_TOKEN/)),
  );
});

test("Workspace単位の設定を読み、Project単位の旧設定（projects[]）は移行手順を示して拒否する", async () => {
  const config = {
    serverUrl: "http://127.0.0.1:1",
    stateDir: "state",
    workspaces: [
      {
        workspaceId: "w-1",
        tokenEnv: "WORKSPACE_RUNTIME_TOKEN",
        agentEnv: { AGENT_MCP_CONFIG: "/etc/w-1.json" },
        projects: [{ projectId: "p-a", agentEnv: { AGENT_MCP_CONFIG: "/etc/p-a.json" } }, { projectId: "p-b" }],
      },
    ],
    roles: { manager: { command: "true" } },
  };
  await withConfig(config, (path) => {
    const loaded = loadConfig(path, { WORKSPACE_RUNTIME_TOKEN: " secret " });
    assert.deepEqual(loaded.workspaces, [
      {
        workspaceId: "w-1",
        tokenEnv: "WORKSPACE_RUNTIME_TOKEN",
        token: "secret",
        agentEnv: { AGENT_MCP_CONFIG: "/etc/w-1.json" },
        projects: [
          { projectId: "p-a", agentEnv: { AGENT_MCP_CONFIG: "/etc/p-a.json" } },
          { projectId: "p-b", agentEnv: {} },
        ],
      },
    ]);
    assert.equal(loaded.stateDir, join(path, "..", "state"));
    assert.throws(() => loadConfig(path, {}), configError(/WORKSPACE_RUNTIME_TOKEN for Workspace w-1 is not set/));
  });
  await withConfig({ ...config, projects: [{ projectId: "p-a", tokenEnv: "RUNTIME_TOKEN" }] }, (path) =>
    assert.throws(() => loadConfig(path, { RUNTIME_TOKEN: "secret" }), configError(/projects\[\] .*no longer supported.*workspaces\[\].*runtime:state:read/)),
  );
  await withConfig({ ...config, workspaces: [config.workspaces[0], config.workspaces[0]] }, (path) =>
    assert.throws(() => loadConfig(path, { WORKSPACE_RUNTIME_TOKEN: "secret" }), configError(/Workspace w-1 is listed more than once/)),
  );
  await withConfig(
    { ...config, workspaces: [config.workspaces[0], { workspaceId: "w-2", tokenEnv: "WORKSPACE_RUNTIME_TOKEN", projects: [{ projectId: "p-a" }] }] },
    (path) => assert.throws(() => loadConfig(path, { WORKSPACE_RUNTIME_TOKEN: "secret" }), configError(/Project p-a is listed more than once/)),
  );
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
    launched.start();
    const result = await launched.done;
    assert.deepEqual(result, { ok: false, error: "timed out after 1500ms" });
    assert.equal(isAgentAlive(launched.pid!), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
