import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 独立したプロセスとして起動したCompass Server（trusted-local・一時DB）とRalphを、MCPだけで接続する結合テスト。
 * Ralphが起動するAgentは`support/fakeAgent.ts`の決定的なfixture（`claude` / `codex`の代わり）で、実LLM・実Agentの
 * 自律運転の実証ではない。起動ディレクトリを一時directoryにし、親プロセスの`COMPASS_*`・`PORT`を引き継がない。
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ralph = join(repositoryRoot, "ralph/bin/ralph");
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

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });

const waitFor = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

type AgentLaunch = { role: string; action: string; provider: string; authorization: string; prompt: string; visibleTokenEnv: string[] };

const setup = async (options: { claimTtlMs?: number } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-ralph-it-"));
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const serverEnv = isolatedEnv({
    PORT: String(port),
    COMPASS_DB_PATH: join(directory, "compass.db"),
    COMPASS_AUTH_MODE: "trusted-local",
    COMPASS_INITIAL_OWNER_EMAIL: "owner@example.com",
    ...(options.claimTtlMs ? { COMPASS_CLAIM_TTL_MS: String(options.claimTtlMs) } : {}),
  });
  const runTs = (script: string, args: string[]) =>
    spawn(process.execPath, ["--import", tsx, script, ...args], { cwd: directory, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  const server = runTs(join(repositoryRoot, "server/src/main.ts"), []);
  const serverExit = exited(server);
  await waitFor(async () => (await fetch(`${serverUrl}/health`)).ok, "the Compass server");

  const mcp = async (principal: string, name: string, args: Record<string, unknown>) => {
    const client = new Client({ name: "ralph-it", version: "0" });
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
    const result = await exited(runTs(join(repositoryRoot, "server/src/cli/main.ts"), args));
    assert.equal(result.code, 0, result.stderr);
  };

  const project = await mcp("admin", "create_project", { name: "Compass", mission: "Keep direction explicit" });
  const projectId = project.id as string;
  for (const [principal, role] of [
    ["manager-1", "manager"],
    ["worker-1", "worker"],
    ["reviewer-1", "reviewer"],
  ]) {
    await cli("grant", projectId, principal!, role!);
  }
  const story = await mcp("manager-1", "issue_story", { projectId, title: "Story", requestId: "story-1" });
  const task = await mcp("manager-1", "issue_task", { projectId, storyId: story.id, title: "Task", requestId: "task-1" });
  const taskId = task.id as string;
  const taskStatus = async () => {
    const { tasks } = await mcp("manager-1", "list_tasks", { projectId });
    return (tasks as { id: string; status: string }[]).find((candidate) => candidate.id === taskId)!.status;
  };

  // claude / codex の代わりに fixture を起動する実行file。providerは引数なしのコマンドpathを要求する。
  const fakeCommand = join(directory, "fake-agent");
  await writeFile(fakeCommand, `#!/bin/sh\nexec "${process.execPath}" --import "${tsx}" "${fakeAgent}" "$@"\n`);
  await chmod(fakeCommand, 0o755);
  const agentLog = join(directory, "agents.jsonl");
  const configPath = join(directory, "ralph.json");
  const writeConfig = (overrides: { reviewerTokenEnv?: string } = {}) =>
    writeFile(
      configPath,
      JSON.stringify({
        serverUrl,
        projectId,
        projectRoot: ".",
        agentProvider: "claude",
        pollIntervalSeconds: 1,
        retry: { initialSeconds: 1, tokenLimitSeconds: 1 },
        logging: { path: "logs/ralph.log" },
        roles: {
          worker: { tokenEnv: "WORKER_TOKEN", agentProvider: "claude", command: fakeCommand },
          reviewer: { tokenEnv: overrides.reviewerTokenEnv ?? "REVIEWER_TOKEN", agentProvider: "codex", command: fakeCommand },
        },
      }),
    );
  await writeConfig();
  const startRalph = (args: string[], extra: { actions?: Record<string, string[]>; env?: Record<string, string> } = {}) =>
    spawn(ralph, ["run", ...args, "--config", configPath], {
      cwd: directory,
      env: isolatedEnv({
        WORKER_TOKEN: "worker-1",
        REVIEWER_TOKEN: "reviewer-1",
        FAKE_AGENT_LOG: agentLog,
        FAKE_AGENT_ACTIONS: JSON.stringify(extra.actions ?? {}),
        FAKE_TOKEN_ENV_NAMES: "WORKER_TOKEN,REVIEWER_TOKEN",
        ...extra.env,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  const launches = (): AgentLaunch[] =>
    existsSync(agentLog)
      ? readFileSync(agentLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AgentLaunch)
      : [];

  return {
    directory,
    projectId,
    taskId,
    mcp,
    taskStatus,
    writeConfig,
    startRalph,
    launches,
    async teardown() {
      server.kill("SIGTERM");
      await serverExit;
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("Worker / Reviewerを別Principal・別Credentialで起動し、作業・レビュー結果がMCPで返る", { skip: loopbackSkip }, async () => {
  const it = await setup();
  try {
    const worker = await exited(it.startRalph(["worker", "--once"]));
    assert.equal(worker.code, 0, worker.stderr);
    assert.equal(await it.taskStatus(), "in_review");

    // 完了したPrincipal（worker-1）はレビュー候補を持たない。別Principalのreviewerが処理する。
    const reviewer = await exited(it.startRalph(["reviewer", "--once"]));
    assert.equal(reviewer.code, 0, reviewer.stderr);
    assert.equal(await it.taskStatus(), "wait_accept");

    const [workerLaunch, reviewerLaunch] = it.launches();
    assert.equal(it.launches().length, 2);
    assert.deepEqual(
      { role: workerLaunch!.role, provider: workerLaunch!.provider, authorization: workerLaunch!.authorization },
      { role: "worker", provider: "claude", authorization: "Bearer worker-1" },
    );
    assert.deepEqual(
      { role: reviewerLaunch!.role, provider: reviewerLaunch!.provider, authorization: reviewerLaunch!.authorization },
      { role: "reviewer", provider: "codex", authorization: "Bearer reviewer-1" },
    );
    // Agentへは自分のRoleのtokenだけをCOMPASS_RALPH_TOKENで渡し、設定したtokenEnvは見せない。
    assert.deepEqual(workerLaunch!.visibleTokenEnv, []);
    assert.deepEqual(reviewerLaunch!.visibleTokenEnv, []);
    // PromptはRole Contextの取得を指示するだけで、Role手順を含まない。
    assert.match(workerLaunch!.prompt, new RegExp(`get_role_context\\(\\{ projectId: "${it.projectId}", role: "worker" \\}\\)`));
    assert.doesNotMatch(workerLaunch!.prompt, /claim_task|complete_task/);

    const { comments } = await it.mcp("manager-1", "list_task_comments", { taskId: it.taskId });
    assert.deepEqual(
      (comments as { principalId: string }[]).map((comment) => comment.principalId),
      ["worker-1", "reviewer-1"],
    );

    const idle = await exited(it.startRalph(["auto", "--once"]));
    assert.equal(idle.code, 0, idle.stderr);
    assert.match(idle.stdout, /対象がないため終了します/);
    assert.equal(it.launches().length, 2);
  } finally {
    await it.teardown();
  }
});

test("WorkerとReviewerに同じCredentialを設定すると起動を拒否する", { skip: loopbackSkip }, async () => {
  const it = await setup();
  try {
    const sameValue = await exited(it.startRalph(["auto", "--once"], { env: { REVIEWER_TOKEN: "worker-1" } }));
    assert.equal(sameValue.code, 1);
    assert.match(sameValue.stderr, /別のCredential/);

    await it.writeConfig({ reviewerTokenEnv: "WORKER_TOKEN" });
    const sameEnv = await exited(it.startRalph(["worker", "--once"]));
    assert.equal(sameEnv.code, 1);
    assert.match(sameEnv.stderr, /別のCredential/);
    assert.equal(it.launches().length, 0);
    assert.equal(await it.taskStatus(), "todo");
  } finally {
    await it.teardown();
  }
});

test("provider失敗を再試行し、停止したAgentのClaimは期限後に再取得してレビューまで進む", { skip: loopbackSkip }, async () => {
  const it = await setup({ claimTtlMs: 2_000 });
  try {
    const loop = it.startRalph(["auto"], { actions: { worker: ["fail", "claim-only", "complete"] } });
    const loopExit = exited(loop);
    await waitFor(async () => (await it.taskStatus()) === "wait_accept", "the Task to be reviewed");
    loop.kill("SIGTERM");
    const result = await loopExit;
    assert.equal(result.code, 143, result.stderr);

    assert.deepEqual(
      it.launches().map((launch) => `${launch.role}:${launch.action}`),
      ["worker:fail", "worker:claim-only", "worker:complete", "reviewer:approve"],
    );
    assert.match(result.stderr, /workerが終了コード 3 で終了しました。 1秒後に再試行します。/);
  } finally {
    await it.teardown();
  }
});

test("Token上限を検出すると--onceでは失敗として終了する", { skip: loopbackSkip }, async () => {
  const it = await setup();
  try {
    const result = await exited(it.startRalph(["worker", "--once"], { actions: { worker: ["limit"] } }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /workerがToken上限に達しました。/);
    assert.equal(await it.taskStatus(), "todo");
  } finally {
    await it.teardown();
  }
});

test("Agentの実行中にSIGTERMを受けると、Agentの終了を待って次を起動せずに終了する", { skip: loopbackSkip }, async () => {
  const it = await setup();
  try {
    const loop = it.startRalph(["auto"], { actions: { worker: ["sleep-complete"] }, env: { FAKE_AGENT_SLEEP_MS: "1500" } });
    const loopExit = exited(loop);
    await waitFor(() => it.launches().length === 1, "the worker to start");
    loop.kill("SIGTERM");
    const result = await loopExit;
    assert.equal(result.code, 143, result.stderr);
    // Agentは中断されずに作業を返し、in_reviewになってもreviewerは起動しない。
    assert.equal(await it.taskStatus(), "in_review");
    assert.deepEqual(
      it.launches().map((launch) => launch.role),
      ["worker"],
    );
  } finally {
    await it.teardown();
  }
});
