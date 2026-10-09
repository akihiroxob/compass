import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 独立したプロセスとして起動したCompass Server（trusted-local・一時DB）とOrchestratorを、MCPだけで接続する結合テスト。
 * OrchestratorはWeb APIで発行したWorkspace Runtime Credentialで状態を読み、Workspace RoleのAgentはWorkspace Agent Credential、
 * Target ProjectのManagerはそのProjectのAgent Credentialで操作する。
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

type Json = Record<string, any>;

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-it-"));
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const origin = `http://localhost:${port}`;
  const ownerEmail = "owner@example.com";
  const serverEnv = isolatedEnv({
    PORT: String(port),
    COMPASS_DB_PATH: join(directory, "compass.db"),
    COMPASS_AUTH_MODE: "trusted-local",
    COMPASS_INITIAL_OWNER_EMAIL: ownerEmail,
  });
  const server = runTs(join(repositoryRoot, "server/src/main.ts"), [], directory, serverEnv);
  const serverExit = exited(server);
  await waitFor(async () => (await fetch(`${serverUrl}/health`)).ok, "the Compass server");

  const mcp = async (bearer: string, name: string, args: Record<string, unknown>) => {
    const client = new Client({ name: "orchestrator-it", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", serverUrl), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}`, Connection: "close" } },
      }),
    );
    try {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Json };
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

  // HumanはWeb UIと同じWeb API（開発用ログイン）でProjectを作り、Workspace / ProjectのCredentialを発行する。
  const login = await fetch(`${serverUrl}/auth/local/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
    body: new URLSearchParams({ email: ownerEmail }).toString(),
  });
  const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]!).join("; ");
  const { csrfToken } = (await (await fetch(`${serverUrl}/api/auth/session`, { headers: { Cookie: cookie } })).json()) as Json;
  const web = async (path: string, body: Json) => {
    const response = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Compass-CSRF": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Json;
    assert.equal(response.status, 201, JSON.stringify(json));
    return json;
  };
  const projectA = (await web("/api/projects", { name: "A", mission: "Keep direction explicit" })).project as Json;
  const workspaceId = projectA.workspaceId as string;
  const projectB = (await web("/api/projects", { name: "B", mission: "M" })).project as Json;
  const database = new DatabaseSync(join(directory, "compass.db"));
  try {
    // 既存WorkspaceへProjectを作る公開入口が未接続のため、BをAと同じWorkspaceへ移す一時DBのfixture。
    database.prepare("update project set workspace_id = ? where id = ?").run(workspaceId, projectB.id);
    // Direction RoleのGrantはWorkspace所有。Workspace Role Grantの付与入口が未接続のため、一時DBへ直接置くfixture。
    const workspaceGrant = database.prepare("insert into workspace_grant (workspace_id, principal_id, role, created_at) values (?, ?, ?, ?)");
    for (const role of ["strategist", "researcher"]) workspaceGrant.run(workspaceId, "direction-agent", role, Date.now());
  } finally {
    database.close();
  }
  const projectIds = [projectA.id as string, projectB.id as string];
  for (const [projectId, principal] of [[projectIds[0]!, "manager-a"], [projectIds[1]!, "manager-b"]]) await cli("grant", projectId!, principal!, "manager");

  // OrchestratorはWorkspace Runtime Credentialで状態を読む。AgentはRole・scopeごとのAgent Credentialを使う。
  const orchestratorToken = (await web(`/api/workspaces/${workspaceId}/credentials`, { kind: "runtime", principalId: "orchestrator", scopes: ["runtime:state:read"] })).token as string;
  const directionToken = (await web(`/api/workspaces/${workspaceId}/credentials`, { kind: "agent", principalId: "direction-agent" })).token as string;
  const managerTokens = [
    (await web(`/api/projects/${projectIds[0]}/credentials`, { kind: "agent", principalId: "manager-a" })).token as string,
    (await web(`/api/projects/${projectIds[1]}/credentials`, { kind: "agent", principalId: "manager-b" })).token as string,
  ];
  await mcp("admin", "create_intent", { workspaceId, title: "Exclusive claims", desiredState: "One owner per Task" });

  const agentLog = join(directory, "agents.jsonl");
  const configPath = join(directory, "orchestrator.json");
  const agentCommand = `"${process.execPath}" --import "${tsx}" "${fakeAgent}"`;
  const roleEnv = (agentEnv: Record<string, string>) => ({ FAKE_AGENT_LOG: agentLog, FAKE_TARGET_PROJECTS: projectIds.join(","), ...agentEnv });
  const workspaceConfig = {
    workspaceId,
    tokenEnv: "ORCHESTRATOR_TOKEN",
    agentEnv: { FAKE_AGENT_TOKEN: directionToken },
    projects: projectIds.map((projectId, index) => ({ projectId, agentEnv: { FAKE_AGENT_TOKEN: managerTokens[index]! } })),
  };
  const writeConfig = (agentEnv: Record<string, string> = {}, overrides: Json = {}) =>
    writeFile(
      configPath,
      JSON.stringify({
        serverUrl,
        stateDir: "state",
        intervalMs: 1000,
        leaseMs: 60_000,
        maxAttempts: 2,
        retryBackoffMs: 0,
        workspaces: [workspaceConfig],
        roles: Object.fromEntries(["strategist", "researcher", "manager"].map((role) => [role, { command: agentCommand, env: roleEnv(agentEnv) }])),
        ...overrides,
      }),
    );
  await writeConfig();
  const orchestrator = (...args: string[]) =>
    runTs(join(repositoryRoot, "orchestrator/src/main.ts"), ["--config", configPath, ...args], directory, isolatedEnv({ ORCHESTRATOR_TOKEN: orchestratorToken }));
  const runOnce = async () => {
    const result = await exited(orchestrator("--once"));
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  const state = () => mcp(orchestratorToken, "get_workspace_orchestration_state", { workspaceId });
  const launches = () =>
    existsSync(agentLog)
      ? readFileSync(agentLog, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                role: string;
                workspaceId: string;
                projectId: string | null;
                subject: string;
                key: string;
                attempt: number;
                pid: number;
                prompt: string;
                credentialVisible: boolean;
              },
          )
      : [];
  const stop = async () => {
    server.kill("SIGTERM");
    await serverExit;
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, workspaceId, projectIds, configPath, mcp, orchestrator, runOnce, state, launches, writeConfig, stop };
};

test(
  "Workspaceの現在状態だけでStrategist→Researcher→Strategist→Target A / BのManagerと起動し、同じ状態では再起動しない",
  { skip: loopbackSkip, timeout: 120_000 },
  async () => {
    const kit = await setup();
    try {
      const [projectA, projectB] = kit.projectIds;
      // 1. Researchは自動作成されず、Intentを受けたWorkspaceのStrategistが起動される（fixtureは追加Researchを依頼する）。
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist"]);
      const [first] = kit.launches();
      assert.match(first!.prompt, new RegExp(`get_workspace_role_context\\(\\{ workspaceId: "${kit.workspaceId}", role: "strategist" \\}\\)`));
      assert.equal(first!.workspaceId, kit.workspaceId);
      assert.equal(first!.projectId, null, "a Workspace Role is not given a Project ID");
      assert.ok(first!.key.startsWith(`${kit.workspaceId}:strategist:intent:`));
      assert.equal(first!.attempt, 1);

      // 2. 未終了のResearchだけを見てResearcherを起動する（fixtureはnot_neededで終える）。
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist", "researcher"]);

      // 3. Researchが終わったIntentはStrategistへ戻る（fixtureはOutcomeを確定し、Target A / Bを設定する）。
      await kit.runOnce();
      // 4. Target A / Bそれぞれの未分解はそのProjectのManagerへ。ManagerはそのProjectのAgent Credentialで Story・Taskを作る。
      await kit.runOnce();
      const launched = kit.launches();
      assert.deepEqual(launched.map(({ role }) => role), ["strategist", "researcher", "strategist", "manager", "manager"]);
      assert.notEqual(launched[0]!.key, launched[2]!.key);
      const outcomeId = launched[3]!.subject.replace("outcome:", "");
      assert.deepEqual(
        launched.slice(3).map(({ key, projectId }) => [key, projectId]).sort(),
        [
          [`${kit.workspaceId}:${projectA}:manager:outcome:${outcomeId}`, projectA],
          [`${kit.workspaceId}:${projectB}:manager:outcome:${outcomeId}`, projectB],
        ].sort(),
      );
      assert.match(launched[3]!.prompt, /get_role_context\(\{ projectId: "[^"]+", role: "manager" \}\)/);
      // OrchestratorのWorkspace Runtime CredentialはどのAgentへも渡さない。
      assert.deepEqual(new Set(launched.map(({ credentialVisible }) => credentialVisible)), new Set([false]));

      // 5. Taskが進行中の間は何も起動しない（Worker / ReviewerはRalphの責務）。再実行しても増えない。
      await kit.runOnce();
      await kit.runOnce();
      assert.equal(kit.launches().length, 5);
      const state = await kit.state();
      assert.deepEqual(
        state.outcomes[0].targets.map(({ projectId, work }: Json) => [projectId, work]),
        [
          [projectA, { state: "incomplete", storyCount: 1, taskCount: 1 }],
          [projectB, { state: "incomplete", storyCount: 1, taskCount: 1 }],
        ],
      );
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
      await waitFor(async () => (await kit.state()).openResearchRequests.length === 1, "the Strategist result");
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

test(
  "Project単位の旧設定は移行手順を示して起動せず、Workspace単位の設定へ移すと旧dispatch記録を引き継がずに起動する",
  { skip: loopbackSkip, timeout: 120_000 },
  async () => {
    const kit = await setup();
    try {
      const [projectA] = kit.projectIds;
      // 既存のProject運転の設定（projects[]）と、Project IDで始まる旧dispatch記録（version 1・Agentは終了済み）が残っている。
      await kit.writeConfig({}, { workspaces: undefined, projects: [{ projectId: projectA, tokenEnv: "ORCHESTRATOR_TOKEN" }] });
      const legacy = await exited(kit.orchestrator("--once"));
      assert.equal(legacy.code, 1);
      assert.match(legacy.stderr, /projects\[\] \(Project-based orchestration\) is no longer supported/);
      assert.equal(kit.launches().length, 0);
      await mkdir(join(kit.directory, "state"), { recursive: true });
      await writeFile(
        join(kit.directory, "state", "dispatches.json"),
        JSON.stringify({ version: 1, records: { [`${projectA}:strategist:intent:legacy`]: { status: "succeeded", attempt: 1, finishedAt: 0 } } }),
      );

      // Workspace単位の設定へ移す: Workspace Runtime Credentialで状態を読み、Workspace IDで始まるkeyで起動する。
      await kit.writeConfig();
      await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist"]);
      const records = JSON.parse(readFileSync(join(kit.directory, "state", "dispatches.json"), "utf8")) as { version: number; records: Json };
      assert.equal(records.version, 2);
      assert.deepEqual(Object.keys(records.records), [kit.launches()[0]!.key]);
    } finally {
      await kit.stop();
    }
  },
);
