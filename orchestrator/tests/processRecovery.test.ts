import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../src/dispatchStore.ts";

/**
 * Orchestrator と Agent を実プロセスで起動し、Orchestrator の強制停止後に残った Agent と同じ dispatch を
 * 同時に動かさないこと、Agent へ Orchestrator の Credential を渡さないことを確かめる。Server は使わない（固定状態）。
 */

const tsx = import.meta.resolve("tsx");
const staticOrchestrator = fileURLToPath(new URL("./support/staticOrchestrator.ts", import.meta.url));
const sleepAgent = fileURLToPath(new URL("./support/sleepAgent.ts", import.meta.url));

type AgentEvent = { event: string; pid: number; attempt: number; at: number; credentialVisible?: boolean; role?: string };

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stderr }));
  });

const waitFor = async (check: () => boolean, what: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const setup = async (agentEnv: Record<string, string>) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-process-"));
  const agentLog = join(directory, "agents.jsonl");
  const configPath = join(directory, "orchestrator.json");
  await writeFile(
    configPath,
    JSON.stringify({
      serverUrl: "http://127.0.0.1:1",
      stateDir: "state",
      intervalMs: 1000,
      leaseMs: 1500,
      maxAttempts: 3,
      retryBackoffMs: 0,
      terminateGraceMs: 1000,
      projects: [{ projectId: "p-1", tokenEnv: "RUNTIME_TOKEN" }],
      roles: {
        strategist: {
          command: `"${process.execPath}" --import "${tsx}" "${sleepAgent}"`,
          env: { SLEEP_AGENT_LOG: agentLog, SLEEP_AGENT_MS: "60000", ...agentEnv },
        },
      },
    }),
  );
  const run = (...args: string[]) =>
    spawn(process.execPath, ["--import", tsx, staticOrchestrator, configPath, ...args], {
      cwd: directory,
      env: { ...process.env, RUNTIME_TOKEN: "runtime-secret" },
      stdio: ["ignore", "ignore", "pipe"],
    });
  const runOnce = async () => {
    const result = await exited(run("--once"));
    assert.equal(result.code, 0, result.stderr);
    return result.stderr;
  };
  const events = (): AgentEvent[] =>
    existsSync(agentLog)
      ? readFileSync(agentLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as AgentEvent)
      : [];
  const starts = () => events().filter(({ event }) => event === "start");
  const cleanup = async () => {
    for (const { pid } of starts()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 既に終了している。
      }
    }
    await rm(directory, { recursive: true, force: true });
  };
  return { run, runOnce, events, starts, cleanup };
};

/** Orchestrator を起動して最初の Agent が起動したら SIGKILL し、Agent だけが残った状態にする。 */
const orphanAgent = async (kit: Awaited<ReturnType<typeof setup>>) => {
  const orchestrator = kit.run();
  const orchestratorExit = exited(orchestrator);
  await waitFor(() => kit.starts().length === 1, "the first launch");
  orchestrator.kill("SIGKILL");
  await orchestratorExit;
  const [first] = kit.starts();
  assert.equal(isProcessAlive(first!.pid), true, "the Agent keeps running after the Orchestrator was killed");
  // Orchestrator が消えたので、Agent 自身の timeout 監視も無い。lease を過ぎるまで待つ。
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(isProcessAlive(first!.pid), true, "nothing stops the Agent while no Orchestrator is running");
  return first!;
};

test("Orchestratorの強制停止後、lease切れの旧Agentを停止してから次の試行を起動し、同じdispatchを同時に動かさない", { timeout: 60_000 }, async () => {
  const kit = await setup({});
  try {
    const first = await orphanAgent(kit);

    // 再起動: 旧Agentが生存している間は起動せず、停止を求める。
    const stderr = await kit.runOnce();
    assert.match(stderr, /lease expired; stopping the previous agent/);
    assert.equal(kit.starts().length, 1);
    await waitFor(() => !isProcessAlive(first.pid), "the previous Agent to stop");

    // 停止を確認した後の周回で、次の試行として起動する。
    const orchestrator = kit.run("--once");
    const orchestratorExit = exited(orchestrator);
    await waitFor(() => kit.starts().length === 2, "the retried launch");
    orchestrator.kill("SIGKILL");
    await orchestratorExit;

    const [, second] = kit.starts();
    assert.equal(second!.attempt, 2);
    const firstEnd = kit.events().find(({ event, pid }) => event === "end" && pid === first.pid);
    assert.ok(firstEnd && firstEnd.at <= second!.at, "the retried Agent starts only after the previous one ended");
  } finally {
    await kit.cleanup();
  }
});

test("SIGTERMで止まらない旧Agentは猶予後にSIGKILLし、停止するまで次の試行を起動しない", { timeout: 60_000 }, async () => {
  const kit = await setup({ SLEEP_AGENT_IGNORE_SIGTERM: "1" });
  try {
    const first = await orphanAgent(kit);

    await kit.runOnce();
    await waitFor(() => kit.events().some(({ event }) => event === "sigterm_ignored"), "SIGTERM to the previous Agent");
    assert.equal(isProcessAlive(first.pid), true);
    // 猶予内（lease + terminateGraceMs 前）は SIGTERM を繰り返すだけで起動しない。
    await kit.runOnce();
    assert.equal(kit.starts().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stderr = await kit.runOnce();
    assert.match(stderr, /"signal":"SIGKILL"/);
    await waitFor(() => !isProcessAlive(first.pid), "SIGKILL to the previous Agent");
    assert.equal(kit.starts().length, 1);

    const orchestrator = kit.run("--once");
    const orchestratorExit = exited(orchestrator);
    await waitFor(() => kit.starts().length === 2, "the retried launch");
    orchestrator.kill("SIGKILL");
    await orchestratorExit;
    assert.equal(kit.starts()[1]!.attempt, 2);
  } finally {
    await kit.cleanup();
  }
});

test("起動したAgentはOrchestratorのRuntime Credentialを環境変数から読めない", { timeout: 60_000 }, async () => {
  const kit = await setup({ SLEEP_AGENT_MS: "0" });
  try {
    await kit.runOnce();
    const [start] = kit.starts();
    assert.equal(start!.role, "strategist");
    assert.equal(start!.credentialVisible, false);
  } finally {
    await kit.cleanup();
  }
});
