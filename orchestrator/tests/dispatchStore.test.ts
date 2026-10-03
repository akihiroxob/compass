import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProcessLock, decideLaunch, DispatchStore, finishRecord, type DispatchRecord } from "../src/dispatchStore.ts";
import type { Dispatch } from "../src/plan.ts";

const policy = { leaseMs: 1000, maxAttempts: 3, retryBackoffMs: 100 };
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
  // lease切れは生存していても回収する（Agentはtimeoutで停止させる）。
  assert.deepEqual(decideLaunch(running({ ownerPid: 12345 }), 1000, policy, alive), { launch: true, attempt: 2, recovered: "lease expired" });
  // 上限に達していれば打ち切る。
  assert.equal(decideLaunch(running({ attempt: 3 }), 1000, policy, alive).launch, false);
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
    store.set("p-1:a", { status: "succeeded", attempt: 1, finishedAt: 0 });
    store.set("p-1:b", running());
    store.set("p-1:c", { status: "failed", attempt: 3, finishedAt: 0, lastError: "x" });
    store.set("p-2:a", { status: "succeeded", attempt: 1, finishedAt: 0 });
    const planned = [{ key: "p-1:a" }] as Dispatch[];
    store.prune("p-1", planned);
    const reopened = new DispatchStore(directory);
    assert.deepEqual(Object.keys(reopened.all()).sort(), ["p-1:a", "p-1:b", "p-2:a"]);
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
