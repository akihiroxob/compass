import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * Workspace境界のE2EではRalph（`ralph/bin/ralph`）も別プロセスで起動し、Ralphが起動するAgentは`ralph/tests/support/fakeAgent.ts`のfixtureを使う。
 * 起動ディレクトリを一時directoryにし、親プロセスの`COMPASS_*`・`PORT`を引き継がない（ローカルの`.env`と既存portから隔離）。
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsx = import.meta.resolve("tsx");
const fakeAgent = fileURLToPath(new URL("./support/fakeAgent.ts", import.meta.url));
const ralph = join(repositoryRoot, "ralph/bin/ralph");
const ralphFakeAgent = join(repositoryRoot, "ralph/tests/support/fakeAgent.ts");

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

const setup = async (options: { claimTtlMs?: number } = {}) => {
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
    ...(options.claimTtlMs ? { COMPASS_CLAIM_TTL_MS: String(options.claimTtlMs) } : {}),
  });
  const server = runTs(join(repositoryRoot, "server/src/main.ts"), [], directory, serverEnv);
  const serverExit = exited(server);
  await waitFor(async () => (await fetch(`${serverUrl}/health`)).ok, "the Compass server");

  /** MCPのtoolを呼び、エラーも含めた応答を返す。`activeRole`があれば`X-Compass-Active-Role`で操作Contextを固定する。 */
  const mcpResult = async (bearer: string, name: string, args: Record<string, unknown>, activeRole?: string) => {
    const client = new Client({ name: "orchestrator-it", version: "0" });
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, Connection: "close" };
    if (activeRole) headers["X-Compass-Active-Role"] = activeRole;
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", serverUrl), { requestInit: { headers } }));
    try {
      return (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Json };
    } finally {
      await client.close();
    }
  };
  const mcp = async (bearer: string, name: string, args: Record<string, unknown>, activeRole?: string) => {
    const result = await mcpResult(bearer, name, args, activeRole);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent!;
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
    for (const role of ["strategist", "researcher", "evaluator"]) workspaceGrant.run(workspaceId, "direction-agent", role, Date.now());
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
  await mcp("admin", "create_intent", {
    workspaceId,
    title: "Exclusive claims",
    desiredState: "One owner per Task",
    completionDefinition: "Every Target Project enforces one owner per Task",
  });

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
        roles: Object.fromEntries(["strategist", "researcher", "manager", "evaluator"].map((role) => [role, { command: agentCommand, env: roleEnv(agentEnv) }])),
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
  return { directory, serverUrl, workspaceId, projectIds, managerTokens, configPath, mcp, mcpResult, web, cli, orchestrator, runOnce, state, launches, writeConfig, stop };
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
  "Workspace境界のE2E: Strategist→Target設定→各Projectのmanager→RalphのWorker / Reviewer→受入・還流→Evaluator→Strategistと接続する",
  { skip: loopbackSkip, timeout: 180_000 },
  async () => {
    // Claimの期限切れ後の再取得を短時間で確かめるため、Claimの期限を短くする。
    const kit = await setup({ claimTtlMs: 2_000 });
    try {
      const [projectA, projectB] = kit.projectIds as [string, string];
      // Orchestrator: Strategist → Researcher → Strategist（Outcome確定・Target A / B設定）→ Target A / Bのmanager。
      for (let round = 0; round < 4; round++) await kit.runOnce();
      assert.deepEqual(kit.launches().map(({ role }) => role), ["strategist", "researcher", "strategist", "manager", "manager"]);
      const outcomeId = kit.launches()[3]!.subject.replace("outcome:", "");
      // managerはProject scopeのまま: 対象Projectと`get_role_context({ projectId })`だけを受け取り、Workspace Roleの指示を受けない。
      for (const manager of kit.launches().slice(3)) {
        assert.equal(manager.workspaceId, kit.workspaceId);
        assert.match(manager.prompt, new RegExp(`get_role_context\\(\\{ projectId: "${manager.projectId}", role: "manager" \\}\\)`));
        assert.doesNotMatch(manager.prompt, /get_workspace_role_context/);
      }

      // Ralphの準備: ProjectごとにWorker / Reviewerを別Principal・別のProject Agent Credentialで接続する。
      // 自己レビュー禁止の回帰のため、AのWorkerのPrincipalにはAのreviewer Grantも付ける。
      const agentToken = async (projectId: string, principalId: string, roles: string[]) => {
        for (const role of roles) await kit.cli("grant", projectId, principalId, role);
        return (await kit.web(`/api/projects/${projectId}/credentials`, { kind: "agent", principalId })).token as string;
      };
      const ralphTokens = {
        [projectA]: { worker: await agentToken(projectA, "worker-a", ["worker", "reviewer"]), reviewer: await agentToken(projectA, "reviewer-a", ["reviewer"]) },
        [projectB]: { worker: await agentToken(projectB, "worker-b", ["worker"]), reviewer: await agentToken(projectB, "reviewer-b", ["reviewer"]) },
      };
      const managerToken = (projectId: string) => kit.managerTokens[kit.projectIds.indexOf(projectId)]!;
      const taskOf = async (projectId: string) => {
        const { tasks } = await kit.mcp(managerToken(projectId), "list_tasks", { projectId }, "manager");
        assert.equal(tasks.length, 1);
        return tasks[0] as { id: string; status: string };
      };
      const fakeCommand = join(kit.directory, "ralph-fake-agent");
      await writeFile(fakeCommand, `#!/bin/sh\nexec "${process.execPath}" --import "${tsx}" "${ralphFakeAgent}" "$@"\n`);
      await chmod(fakeCommand, 0o755);
      const contextLog = join(kit.directory, "ralph-contexts.jsonl");
      /** RalphはProjectごとに1つの設定で起動する。設定に持つのはProject IDだけで、Workspace IDを持たない。 */
      const ralphFor = async (projectId: string, label: string) => {
        const root = join(kit.directory, `ralph-${label}`);
        await mkdir(root, { recursive: true });
        const configPath = join(root, "ralph.json");
        await writeFile(
          configPath,
          JSON.stringify({
            serverUrl: kit.serverUrl,
            projectId,
            projectRoot: ".",
            agentProvider: "claude",
            pollIntervalSeconds: 1,
            retry: { initialSeconds: 1, tokenLimitSeconds: 1 },
            logging: { path: "logs/ralph.log" },
            roles: {
              worker: { tokenEnv: "WORKER_TOKEN", agentProvider: "claude", command: fakeCommand },
              reviewer: { tokenEnv: "REVIEWER_TOKEN", agentProvider: "codex", command: fakeCommand },
            },
          }),
        );
        const agentLog = join(root, "agents.jsonl");
        return {
          start: (args: string[], actions: Record<string, string[]> = {}) =>
            spawn(ralph, ["run", ...args, "--config", configPath], {
              cwd: root,
              env: isolatedEnv({
                WORKER_TOKEN: ralphTokens[projectId]!.worker,
                REVIEWER_TOKEN: ralphTokens[projectId]!.reviewer,
                FAKE_AGENT_LOG: agentLog,
                FAKE_AGENT_CONTEXT_LOG: contextLog,
                FAKE_AGENT_ACTIONS: JSON.stringify(actions),
              }),
              stdio: ["ignore", "pipe", "pipe"],
            }),
          launches: () =>
            existsSync(agentLog)
              ? readFileSync(agentLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { role: string; action: string; prompt: string })
              : [],
        };
      };

      // Project A: Workerの失敗を再試行し、Claimを残して止まったAgentのTaskを期限後に別のClaimで再取得して完了する。
      const ralphA = await ralphFor(projectA, "a");
      const workerLoop = ralphA.start(["worker"], { worker: ["fail", "claim-only", "complete"] });
      const workerExit = exited(workerLoop);
      await waitFor(async () => (await taskOf(projectA)).status === "in_review", "Project A's Task to be completed", 60_000);
      workerLoop.kill("SIGTERM");
      const workerResult = await workerExit;
      assert.equal(workerResult.code, 143, workerResult.stderr);
      assert.match(workerResult.stderr, /workerが終了コード 3 で終了しました。 1秒後に再試行します。/);
      assert.deepEqual(ralphA.launches().map(({ role, action }) => `${role}:${action}`), ["worker:fail", "worker:claim-only", "worker:complete"]);

      // 自己レビュー禁止: reviewer GrantがあってもTaskを完了したPrincipalにはレビュー候補が無く、claim_reviewはWorkが拒否する。
      const taskA = await taskOf(projectA);
      const selfReviewCandidates = await kit.mcp(ralphTokens[projectA]!.worker, "list_tasks", { projectId: projectA, filter: { availableFor: "review" } }, "reviewer");
      assert.deepEqual(selfReviewCandidates.tasks, []);
      const selfReview = await kit.mcpResult(ralphTokens[projectA]!.worker, "claim_review", { taskId: taskA.id, requestId: "self-review" }, "reviewer");
      assert.equal(selfReview.isError, true);
      assert.equal(selfReview.structuredContent?.error?.code, "SELF_REVIEW_NOT_ALLOWED");

      // 別PrincipalのReviewerがレビューする。
      const reviewerA = await exited(ralphA.start(["reviewer", "--once"]));
      assert.equal(reviewerA.code, 0, reviewerA.stderr);
      assert.equal((await taskOf(projectA)).status, "wait_accept");

      // Project B: 自動モードで Worker → Reviewer の順に1件ずつ処理する。
      const ralphB = await ralphFor(projectB, "b");
      for (let round = 0; round < 2; round++) {
        const result = await exited(ralphB.start(["auto", "--once"]));
        assert.equal(result.code, 0, result.stderr);
      }
      assert.equal((await taskOf(projectB)).status, "wait_accept");
      assert.deepEqual(ralphB.launches().map(({ role }) => role), ["worker", "reviewer"]);

      // RalphはProject execution loopのまま: 起動指示はProjectの`get_role_context`だけで、Workspace IDを含まない。
      // Workspaceの要約とTargetのOutcomeは、Ralphの設定ではなくServerのRole Contextから受け取る。
      for (const [projectId, launches] of [[projectA, ralphA.launches()], [projectB, ralphB.launches()]] as const) {
        for (const launch of launches) {
          assert.match(launch.prompt, new RegExp(`get_role_context\\(\\{ projectId: "${projectId}", role: "${launch.role}" \\}\\)`));
          assert.doesNotMatch(launch.prompt, new RegExp(kit.workspaceId));
        }
      }
      const contexts = readFileSync(contextLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
      assert.equal(contexts.length, ralphA.launches().length - 1 + ralphB.launches().length, "every launched Agent except the failed one read its Role Context");
      for (const context of contexts) {
        assert.equal(context.workspaceId, kit.workspaceId);
        assert.deepEqual(context.outcomeIds, [outcomeId]);
      }

      // Worker / Reviewerの段階ではOrchestratorは何も起動しない（RalphとOrchestratorの責務の分離）。
      await kit.runOnce();
      assert.equal(kit.launches().length, 5);

      // 最終受入は各Projectのmanager（Ralphの対象外）、Executionの還流はProjectのRuntime。Orchestratorはどちらも起動しないため、
      // テストがMCPで操作する（未接続の工程）。
      const reflect = async (projectId: string, label: string) => {
        const task = await taskOf(projectId);
        const acceptance = await kit.mcp(managerToken(projectId), "claim_acceptance", { taskId: task.id, requestId: `accept-claim-${label}` }, "manager");
        await kit.mcp(managerToken(projectId), "accept_task", { taskId: task.id, claimId: acceptance.claimId, requestId: `accept-${label}` }, "manager");
        const runtimeToken = (
          await kit.web(`/api/projects/${projectId}/credentials`, {
            kind: "runtime",
            principalId: `runtime-${label}`,
            scopes: ["execution:change:read", "execution:evidence:write"],
          })
        ).token as string;
        const changes = await kit.mcp(runtimeToken, "list_changes", { projectId, afterCursor: 0 });
        const evidence = [{ kind: "pull_request", uri: `https://github.com/example/${label}/pull/1`, versionHash: "a".repeat(40), observedAt: Date.now() - 1_000 }];
        const reflected = await kit.mcp(runtimeToken, "record_execution_evidence", { projectId, outcomeId, changeCursor: changes.nextCursor, evidence });
        assert.equal(reflected.summary.state, "accepted");
      };

      // 一部のTargetの還流だけではEvaluatorを起動しない。
      await reflect(projectA, "a");
      await kit.runOnce();
      assert.equal(kit.launches().length, 5);

      // 全Targetが還流するとWorkspaceのEvaluatorを起動し、そのEvaluationを根拠にStrategistがIntentの完了を判断する。
      await reflect(projectB, "b");
      await kit.runOnce();
      await kit.runOnce();
      const launched = kit.launches();
      assert.deepEqual(launched.map(({ role }) => role), ["strategist", "researcher", "strategist", "manager", "manager", "evaluator", "strategist"]);
      const [evaluator, strategist] = launched.slice(5);
      for (const [launch, role] of [[evaluator!, "evaluator"], [strategist!, "strategist"]] as const) {
        assert.equal(launch.projectId, null, "a Workspace Role is not given a Project ID");
        assert.match(launch.prompt, new RegExp(`get_workspace_role_context\\(\\{ workspaceId: "${kit.workspaceId}", role: "${role}" \\}\\)`));
      }
      assert.equal(evaluator!.subject, `outcome:${outcomeId}`);
      assert.ok(strategist!.subject.startsWith("evaluation:"));
      assert.deepEqual(new Set(launched.map(({ credentialVisible }) => credentialVisible)), new Set([false]));

      // Intentは達成済みになり、Active Intentの無いWorkspaceでは何も起動しない。
      const finalState = await kit.state();
      assert.equal(finalState.activeIntent, null);
      await kit.runOnce();
      assert.equal(kit.launches().length, 7);
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
