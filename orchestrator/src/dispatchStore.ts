import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dispatch } from "./plan.ts";

/**
 * 起動の重複抑止に使う、dispatch key ごとの起動記録。workflow の正本ではない（起動判断は毎回 Server の現在状態から行う）。
 * 状態が進んで key が計画から消えた記録は捨てる。
 */
export type DispatchRecord =
  | { status: "running"; attempt: number; startedAt: number; leaseExpiresAt: number; ownerPid: number; childPid: number | null }
  | { status: "retry_wait"; attempt: number; nextAttemptAt: number; lastError: string }
  | { status: "succeeded"; attempt: number; finishedAt: number }
  | { status: "failed"; attempt: number; finishedAt: number; lastError: string };

export type DispatchPolicy = {
  leaseMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  terminateGraceMs: number;
};

type StoreFile = { version: 1; records: Record<string, DispatchRecord> };

/** プロセスが生きているか。権限不足（EPERM）は存在するとみなす。 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Agent は process group の leader として起動する（Windows を除く）。 */
export const agentProcessGroup = process.platform !== "win32";

/**
 * 起動した Agent がまだ動いているか。shell 経由の孫プロセスも含めるため process group の生存を見る。
 * 権限不足（EPERM）は存在するとみなす。
 */
export const isAgentAlive = (pid: number): boolean => {
  if (!agentProcessGroup) return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultAlive = (pid: number, kind: "owner" | "agent") => (kind === "agent" ? isAgentAlive(pid) : isProcessAlive(pid));

export type LaunchDecision =
  | { launch: true; attempt: number; recovered?: string }
  | { launch: false; reason: string; record?: DispatchRecord; terminate?: { pid: number; signal: NodeJS.Signals } };

/**
 * 記録と現在時刻から、この key を今起動してよいかを決める純関数。
 * - 実行中（lease 内・所有プロセスが生存）は起動しない（並行・重複起動の抑止）
 * - lease 切れで Agent が生存している実行中は起動せず、Agent の停止を求める（SIGTERM、猶予後は SIGKILL）。
 *   Orchestrator が停止して timeout の監視が消えても、旧 Agent と同じ key を同時に動かさない
 * - 所有プロセスが停止した、または lease 切れの実行中は、Agent の停止を確認してから失敗した試行として扱い、
 *   再試行の規則に従う（再起動後の回収）
 * - 再試行待ちは backoff 経過後だけ、上限到達後は起動しない
 * - 成功済みは同じ状態（key）で再起動しない
 */
export const decideLaunch = (
  record: DispatchRecord | undefined,
  now: number,
  policy: DispatchPolicy,
  alive: (pid: number, kind: "owner" | "agent") => boolean = defaultAlive,
): LaunchDecision => {
  if (!record) return { launch: true, attempt: 1 };
  switch (record.status) {
    case "succeeded":
      return { launch: false, reason: "already succeeded for this state", record };
    case "failed":
      return { launch: false, reason: `gave up after ${record.attempt} attempts: ${record.lastError}`, record };
    case "retry_wait":
      if (now < record.nextAttemptAt) return { launch: false, reason: "waiting for retry backoff", record };
      return { launch: true, attempt: record.attempt + 1 };
    case "running": {
      const ownerAlive = record.ownerPid === process.pid || alive(record.ownerPid, "owner");
      const childAlive = record.childPid !== null && alive(record.childPid, "agent");
      if (now < record.leaseExpiresAt && (ownerAlive || childAlive)) {
        return { launch: false, reason: "already running", record };
      }
      if (childAlive) {
        const signal = now >= record.leaseExpiresAt + policy.terminateGraceMs ? "SIGKILL" : "SIGTERM";
        return { launch: false, reason: "lease expired; stopping the previous agent", record, terminate: { pid: record.childPid!, signal } };
      }
      const recovered = now >= record.leaseExpiresAt ? "lease expired" : "orchestrator stopped while running";
      if (record.attempt >= policy.maxAttempts) {
        return { launch: false, reason: `gave up after ${record.attempt} attempts: ${recovered}`, record };
      }
      return { launch: true, attempt: record.attempt + 1, recovered };
    }
  }
};

/** 試行の終了を記録へ反映する。失敗は上限まで backoff 付きで再試行待ちにする。 */
export const finishRecord = (
  attempt: number,
  result: { ok: true } | { ok: false; error: string },
  now: number,
  policy: DispatchPolicy,
): DispatchRecord => {
  if (result.ok) return { status: "succeeded", attempt, finishedAt: now };
  if (attempt >= policy.maxAttempts) return { status: "failed", attempt, finishedAt: now, lastError: result.error };
  return {
    status: "retry_wait",
    attempt,
    nextAttemptAt: now + policy.retryBackoffMs * 2 ** (attempt - 1),
    lastError: result.error,
  };
};

/**
 * dispatch 記録を state directory の JSON file に保存する。書込は一時 file からの rename で行い、途中で停止しても壊さない。
 * 同じ state directory を使う Orchestrator は `acquireProcessLock` で同時に1つだけにする。
 */
export class DispatchStore {
  private readonly path: string;
  private records: Record<string, DispatchRecord>;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, "dispatches.json");
    this.records = this.load();
  }

  private load(): Record<string, DispatchRecord> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
      return parsed.version === 1 && parsed.records ? parsed.records : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Cannot read the dispatch store ${this.path}: ${(error as Error).message}`);
    }
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, records: this.records } satisfies StoreFile, null, 2));
    renameSync(temporary, this.path);
  }

  get(key: string): DispatchRecord | undefined {
    return this.records[key];
  }

  all(): Readonly<Record<string, DispatchRecord>> {
    return this.records;
  }

  set(key: string, record: DispatchRecord): void {
    this.records[key] = record;
    this.save();
  }

  /**
   * 指定 Project の記録のうち、現在の計画に無く実行中でもないものを捨てる（状態が進んだ）。
   * 失敗で打ち切った記録も、状態が変わって key が消えれば捨てる。
   */
  prune(projectId: string, planned: readonly Dispatch[]): void {
    const keep = new Set(planned.map((dispatch) => dispatch.key));
    let changed = false;
    for (const [key, record] of Object.entries(this.records)) {
      if (!key.startsWith(`${projectId}:`) || keep.has(key) || record.status === "running") continue;
      delete this.records[key];
      changed = true;
    }
    if (changed) this.save();
  }
}

/** 同じ state directory で Orchestrator を同時に1つだけ動かす。停止したプロセスが残した lock は引き継ぐ。 */
export const acquireProcessLock = (directory: string): (() => void) => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "orchestrator.lock");
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isProcessAlive(owner)) {
        throw new Error(`Another orchestrator (pid ${owner}) is running with the state directory ${directory}`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Cannot acquire the orchestrator lock in ${directory}`);
};
