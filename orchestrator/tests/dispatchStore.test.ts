import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProcessLock, decideLaunch, DispatchStore, finishRecord, type DispatchRecord } from "../src/dispatchStore.ts";
import type { WorkspaceDispatch } from "../src/plan.ts";

const policy = { leaseMs: 1000, maxAttempts: 3, retryBackoffMs: 100, terminateGraceMs: 500 };
const deadPid = 2_147_483_646;
const alive = (pid: number) => pid !== deadPid;

const running = (overrides: Partial<Extract<DispatchRecord, { status: "running" }>> = {}): DispatchRecord => ({
  status: "running",
  attempt: 1,
  startedAt: 0,
  leaseExpiresAt: 1000,
  ownerPid: deadPid,
  childPid: null,
  ...overrides,
});

test("記録が無ければ起動し、成功済み・打ち切り済みは同じkeyで起動しない", () => {
  assert.deepEqual(decideLaunch(undefined, 0, policy, alive), { launch: true, attempt: 1 });
  assert.equal(decideLaunch({ status: "succeeded", attempt: 1, finishedAt: 0 }, 10, policy, alive).launch, false);
  assert.equal(decideLaunch({ status: "failed", attempt: 3, finishedAt: 0, lastError: "x" }, 10, policy, alive).launch, false);
});

test("実行中はleaseの間起動せず、所有プロセス・子プロセスがともに停止していれば再起動後に回収する", () => {
  // 別のOrchestratorが所有し生存している（並行起動）。
  assert.equal(decideLaunch(running({ ownerPid: 12345 }), 10, policy, alive).launch, false);
  // Orchestratorは停止したが、起動したAgentはまだ動いている（再起動直後）。
  assert.equal(decideLaunch(running({ childPid: 12345 }), 10, policy, alive).launch, false);
  // どちらも停止している: 失敗した試行として次の試行へ。
  assert.deepEqual(decideLaunch(running(), 10, policy, alive), { launch: true, attempt: 2, recovered: "orchestrator stopped while running" });
  // lease切れで所有プロセスだけが生存している（Agentは停止済み）: 次の試行へ。
  assert.deepEqual(decideLaunch(running({ ownerPid: 12345 }), 1000, policy, alive), { launch: true, attempt: 2, recovered: "lease expired" });
  // 上限に達していれば打ち切る。
  assert.equal(decideLaunch(running({ attempt: 3 }), 1000, policy, alive).launch, false);
});

test("lease切れでも旧Agentが生存している間は同じkeyを起動せず、停止を求めて猶予後はSIGKILLにする", () => {
  // Orchestratorが停止し（SIGKILL等でtimeoutの監視も消えた）、旧Agentだけが残っている。
  const orphan = running({ childPid: 222 });
  const kinds: string[] = [];
  const probe = (pid: number, kind: "owner" | "agent") => {
    kinds.push(`${kind}:${pid}`);
    return alive(pid);
  };
  assert.deepEqual(decideLaunch(orphan, 1000, policy, probe), {
    launch: false,
    reason: "lease expired; stopping the previous agent",
    record: orphan,
    terminate: { pid: 222, signal: "SIGTERM" },
  });
  assert.deepEqual(kinds, [`owner:${deadPid}`, "agent:222"]);
  assert.deepEqual((decideLaunch(orphan, 1499, policy, alive) as { terminate?: unknown }).terminate, { pid: 222, signal: "SIGTERM" });
  assert.deepEqual((decideLaunch(orphan, 1500, policy, alive) as { terminate?: unknown }).terminate, { pid: 222, signal: "SIGKILL" });
  // 上限到達でも、旧Agentの停止を確認するまでは打ち切りを確定しない。
  assert.equal((decideLaunch(running({ childPid: 222, attempt: 3 }), 1000, policy, alive) as { reason?: string }).reason, "lease expired; stopping the previous agent");
  // 旧Agentの停止を確認した後に、失敗した試行として次の試行へ進む。
  assert.deepEqual(decideLaunch(orphan, 1000, policy, (pid) => pid !== deadPid && pid !== 222), { launch: true, attempt: 2, recovered: "lease expired" });
});

test("失敗はbackoff付きで上限まで再試行し、成功で確定する", () => {
  const first = finishRecord(1, { ok: false, error: "exit 1" }, 0, policy);
  assert.deepEqual(first, { status: "retry_wait", attempt: 1, nextAttemptAt: 100, lastError: "exit 1" });
  assert.equal(decideLaunch(first, 99, policy, alive).launch, false);
  assert.deepEqual(decideLaunch(first, 100, policy, alive), { launch: true, attempt: 2 });
  const second = finishRecord(2, { ok: false, error: "exit 1" }, 100, policy);
  assert.equal((second as { nextAttemptAt: number }).nextAttemptAt, 300);
  assert.deepEqual(finishRecord(3, { ok: false, error: "exit 1" }, 300, policy), { status: "failed", attempt: 3, finishedAt: 300, lastError: "exit 1" });
  assert.deepEqual(finishRecord(2, { ok: true }, 400, policy), { status: "succeeded", attempt: 2, finishedAt: 400 });
});

test("記録はfileに残り、計画から消えた非実行中の記録だけを捨てる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-store-"));
  try {
    const store = new DispatchStore(directory);
    store.set("w-1:strategist:a", { status: "succeeded", attempt: 1, finishedAt: 0 });
    store.set("w-1:p-a:manager:outcome:o-1", running());
    store.set("w-1:p-b:manager:outcome:o-1", { status: "failed", attempt: 3, finishedAt: 0, lastError: "x" });
    store.set("w-2:strategist:a", { status: "succeeded", attempt: 1, finishedAt: 0 });
    const planned = [{ key: "w-1:strategist:a" }] as WorkspaceDispatch[];
    store.prune("w-1", planned);
    const reopened = new DispatchStore(directory);
    assert.deepEqual(Object.keys(reopened.all()).sort(), ["w-1:p-a:manager:outcome:o-1", "w-1:strategist:a", "w-2:strategist:a"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Project基準のOrchestratorの記録（version 1）は、Agentが動いていれば読込を拒否し、動いていなければ捨てる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-legacy-store-"));
  try {
    const path = join(directory, "dispatches.json");
    const legacy = {
      version: 1,
      records: {
        "p-1:strategist:intent:i-1:v": running({ childPid: 222 }),
        "p-1:researcher:research_request:r-1": { status: "succeeded", attempt: 1, finishedAt: 0 },
      },
    };
    await writeFile(path, JSON.stringify(legacy));
    // 旧Agentが動いている: 新しいkeyで同じ論理起動を重ねないよう、Orchestratorを起動させない。
    assert.throws(() => new DispatchStore(directory, (pid) => pid === 222), /Project-based launches whose Agents are still running \(p-1:strategist:intent:i-1:v\)/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy, "the legacy records are kept while refusing");
    // 旧Agentが終わった後は、旧keyの記録を引き継がず空から始める（新しいkeyはWorkspace IDで始まる）。
    const store = new DispatchStore(directory, () => false);
    assert.deepEqual(store.all(), {});
    store.set("w-1:strategist:intent:i-1:v", { status: "succeeded", attempt: 1, finishedAt: 0 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 2,
      records: { "w-1:strategist:intent:i-1:v": { status: "succeeded", attempt: 1, finishedAt: 0 } },
    });
    assert.deepEqual(Object.keys(new DispatchStore(directory, () => true).all()), ["w-1:strategist:intent:i-1:v"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同じstate directoryでは同時に1つだけ動き、停止したプロセスのlockは引き継ぐ", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-orchestrator-lock-"));
  try {
    // 生存中の別プロセス（親プロセス）が所有している。
    await writeFile(join(directory, "orchestrator.lock"), String(process.ppid));
    assert.throws(() => acquireProcessLock(directory), /Another orchestrator/);
    // 停止したプロセスのlockは引き継げる。
    await writeFile(join(directory, "orchestrator.lock"), String(deadPid));
    const release = acquireProcessLock(directory);
    release();
    acquireProcessLock(directory)();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
