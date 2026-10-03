import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 独立したプロセスとして起動したCompass Server（trusted-local・一時DB）とOrchestratorを、MCPだけで接続する結合テスト。
 * 起動されるAgentは`support/fakeAgent.ts`の決定的なfixtureで、実LLM・実Agentの自律運転の実証ではない。
 * 起動ディレクトリを一時directoryにし、親プロセスの`COMPASS_*`・`PORT`を引き継がない（ローカルの`.env`と既存portから隔離）。
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsx = import.meta.resolve("tsx");
const fakeAgent = fileURLToPath(new URL("./support/fakeAgent.ts", import.meta.url));

const loopbackDenial = await new Promise<string | undefined>((resolve) => {
  const probe = createServer();
  probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EPERM" || error.code === "EACCES" ? error.code : undefined));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(undefined)));
});
const loopbackSkip = loopbackDenial ? `127.0.0.1へのlistenが拒否された（${loopbackDenial}）。sandbox外で実行すること` : false;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const isolatedEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COMPASS_") && name !== "PORT")),
  ...extra,
});

const runTs = (script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  spawn(process.execPath, ["--import", tsx, script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });

const waitFor = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-it-"));
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const serverEnv = isolatedEnv({
    PORT: String(port),
    COMPASS_DB_PATH: join(directory, "compass.db"),
    COMPASS_AUTH_MODE: "trusted-local",
    COMPASS_INITIAL_OWNER_EMAIL: "owner@example.com",
  });
  const server = runTs(join(repositoryRoot, "server/src/main.ts"), [], directory, serverEnv);
  const serverExit = exited(server);
  await waitFor(async () => (await fetch(`${serverUrl}/health`)).ok, "the Compass server");

  const mcp = async (principal: string, name: string, args: Record<string, unknown>) => {
    const client = new Client({ name: "orchestrator-it", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", serverUrl), {
        requestInit: { headers: { Authorization: `Bearer ${principal}`, Connection: "close" } },
      }),
    );
    try {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    } finally {
      await client.close();
    }
  };
  const cli = async (...args: string[]) => {
    const result = await exited(runTs(join(repositoryRoot, "server/src/cli/main.ts"), args, directory, serverEnv));
    assert.equal(result.code, 0, result.stderr);
  };

  const project = await mcp("admin", "create_project", { name: "Compass", mission: "Keep direction explicit" });
  const projectId = project.id as string;
  for (const [principal, role] of [
    ["orchestrator-1", "runtime"],
    ["strategist-1", "strategist"],
    ["researcher-1", "researcher"],
    ["manager-1", "manager"],
  ]) {
    await cli("grant", projectId, principal!, role!);
  }
  await mcp("admin", "create_intent", { projectId, title: "Exclusive claims", desiredState: "One owner per Task" });

  const agentLog = join(directory, "agents.jsonl");
  const configPath = join(directory, "orchestrator.json");
  const agentCommand = `"${process.execPath}" --import "${tsx}" "${fakeAgent}"`;
  const writeConfig = (agentEnv: Record<string, string> = {}) =>
    writeFile(
      configPath,
      JSON.stringify({
        serverUrl,
        stateDir: "state",
        intervalMs: 1000,
        leaseMs: 60_000,
        maxAttempts: 2,
        retryBackoffMs: 0,
        projects: [{ projectId, tokenEnv: "ORCHESTRATOR_TOKEN" }],
        roles: Object.fromEntries(
          ["strategist", "researcher", "manager"].map((role) => [role, { command: agentCommand, env: { FAKE_AGENT_LOG: agentLog, ...agentEnv } }]),
        ),
      }),
    );
  await writeConfig();
  const orchestrator = (...args: string[]) =>
    runTs(join(repositoryRoot, "orchestrator/src/main.ts"), ["--config", configPath, ...args], directory, isolatedEnv({ ORCHESTRATOR_TOKEN: "orchestrator-1" }));
  const runOnce = async () => {
    const result = await exited(orchestrator("--once"));
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  const launches = () =>
    existsSync(agentLog)
      ? readFileSync(agentLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { role: string; subject: string; key: string; attempt: number; pid: number; prompt: string; credentialVisible: boolean })
      : [];
  const stop = async () => {
    server.kill("SIGTERM");
    await serverExit;
    await rm(directory, { recursive: true, force: true });
  };
  return { projectId, mcp, orchestrator, runOnce, launches, writeConfig, stop };
};

test(
  "現在状態だけでIntent→Strategist→Researcher→Strategist→Managerと起動し、同じ状態では再起動しない",
  { skip: loopbackSkip, timeout: 120_000 },
  async () => {
    const kit = await setup();
    try {
      // 1. Researchは自動作成されず、Intentを受けたStrategistが起動される（fixtureは追加Researchを依頼する）。
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist"]);
      const [first] = kit.launches();
      assert.match(first!.prompt, /get_role_context/);
      assert.equal(first!.attempt, 1);
      // OrchestratorのRuntime CredentialはAgentへ渡さない。
      assert.equal(first!.credentialVisible, false);

      // 2. 未終了のResearchだけを見てResearcherを起動する（fixtureはnot_neededで終える）。
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist", "researcher"]);

      // 3. Researchが終わったIntentはStrategistへ戻る（fixtureはOutcomeを確定する）。
      await kit.runOnce();
      // 4. 未分解のOutcomeはManagerへ（fixtureはStory・Taskを作る）。
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist", "researcher", "strategist", "manager"]);
      assert.notEqual(kit.launches()[0]!.key, kit.launches()[2]!.key);

      // 5. Taskが進行中の間は何も起動しない（Worker / ReviewerはRalphの責務）。再実行しても増えない。
      await kit.runOnce();
      await kit.runOnce();
      assert.equal(kit.launches().length, 4);
      const state = await kit.mcp("orchestrator-1", "get_orchestration_state", { projectId: kit.projectId });
      assert.deepEqual(state.outcomes[0].work, { state: "incomplete", storyCount: 1, taskCount: 1 });
    } finally {
      await kit.stop();
    }
  },
);

test(
  "同じstate directoryのOrchestratorは同時に1つだけで、停止後の再起動は実行中のAgentを重複起動しない",
  { skip: loopbackSkip, timeout: 120_000 },
  async () => {
    const kit = await setup();
    try {
      await kit.writeConfig({ FAKE_AGENT_SLEEP_MS: "3000" });
      const running = kit.orchestrator();
      const runningExit = exited(running);
      await waitFor(() => kit.launches().length === 1, "the first launch");

      // 並行起動: 2つ目のOrchestratorはlockで拒否され、何も起動しない。
      const second = await exited(kit.orchestrator("--once"));
      assert.equal(second.code, 1);
      assert.match(second.stderr, /Another orchestrator/);

      // 再起動: Orchestratorだけが強制停止し、起動済みのAgentは動き続けている。
      running.kill("SIGKILL");
      await runningExit;
      const [launch] = kit.launches();
      assert.doesNotThrow(() => process.kill(launch!.pid, 0), "the Agent keeps running after the Orchestrator stopped");
      const restarted = await kit.runOnce();
      assert.match(restarted.stderr, /already running/);
      assert.equal(kit.launches().length, 1);

      // Agentが状態を進めて終わった後は、次の状態（Research）だけを起動する。Strategistは再起動しない。
      await waitFor(async () => (await kit.mcp("orchestrator-1", "get_orchestration_state", { projectId: kit.projectId })).openResearchRequests.length === 1, "the Strategist result");
      await kit.writeConfig();
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist", "researcher"]);
    } finally {
      await kit.stop();
    }
  },
);

test(
  "Agentの失敗は上限まで再試行し、上限後は同じ状態で起動しない",
  { skip: loopbackSkip, timeout: 120_000 },
  async () => {
    const kit = await setup();
    try {
      await kit.writeConfig({ FAKE_AGENT_EXIT: "1" });
      await kit.runOnce();
      await kit.runOnce();
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role, attempt }) => [role, attempt]), [
        ["strategist", 1],
        ["strategist", 2],
      ]);
    } finally {
      await kit.stop();
    }
  },
);
