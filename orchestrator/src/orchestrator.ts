import type { CompassStateReader } from "./compassClient.ts";
import type { OrchestratorConfig } from "./config.ts";
import { decideLaunch, finishRecord, type DispatchPolicy, type DispatchStore } from "./dispatchStore.ts";
import { terminateAgent, type AgentLauncher } from "./launcher.ts";
import { planDispatches, type Dispatch } from "./plan.ts";

/** Operational Log。stdout / stderr へ出す実行記録で、Compass の Activity・Change Log には書かない。 */
export type OperationalLog = (event: string, fields: Record<string, unknown>) => void;

export const jsonLog: OperationalLog = (event, fields) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

export type TickReport = {
  launched: Dispatch[];
  skipped: { key: string; reason: string }[];
  failedProjects: { projectId: string; error: string }[];
};

/**
 * Project 横断で現在状態を読み、起動すべき専門 Role を起動する。判断は `planDispatches` の明示的な状態判定だけで、
 * 知的判断は起動された Role に委ねる。起動の重複は dispatch key の記録（`DispatchStore`）で抑止する。
 */
export class Orchestrator {
  private readonly running = new Map<string, Promise<void>>();
  private readonly policy: DispatchPolicy;

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly reader: CompassStateReader,
    private readonly launcher: AgentLauncher,
    private readonly store: DispatchStore,
    private readonly clock: () => number = Date.now,
    private readonly log: OperationalLog = jsonLog,
    private readonly terminate: (pid: number, signal: NodeJS.Signals) => void = terminateAgent,
  ) {
    this.policy = {
      leaseMs: config.leaseMs,
      maxAttempts: config.maxAttempts,
      retryBackoffMs: config.retryBackoffMs,
      terminateGraceMs: config.terminateGraceMs,
    };
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { launched: [], skipped: [], failedProjects: [] };
    for (const project of this.config.projects) {
      let planned: Dispatch[];
      try {
        planned = planDispatches(await this.reader.getOrchestrationState(project.projectId, project.token));
      } catch (error) {
        // 状態を読めない Project は起動も記録の整理もしない（次の周回で読み直す）。
        const message = (error as Error).message;
        report.failedProjects.push({ projectId: project.projectId, error: message });
        this.log("state_read_failed", { projectId: project.projectId, error: message });
        continue;
      }
      this.store.prune(project.projectId, planned);
      for (const dispatch of planned) {
        const skipped = this.tryLaunch(dispatch, report);
        if (skipped) {
          report.skipped.push({ key: dispatch.key, reason: skipped });
          this.log("dispatch_skipped", { key: dispatch.key, role: dispatch.role, reason: skipped });
        }
      }
    }
    return report;
  }

  /** 起動した Agent がすべて終わるまで待つ（`--once` と停止時に使う）。 */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  private tryLaunch(dispatch: Dispatch, report: TickReport): string | null {
    const command = this.config.roles[dispatch.role];
    if (!command) return `no command is configured for the ${dispatch.role} Role`;
    if (this.running.has(dispatch.key)) return "already running";
    const now = this.clock();
    const decision = decideLaunch(this.store.get(dispatch.key), now, this.policy);
    if (!decision.launch) {
      const record = decision.record;
      // lease 切れで旧 Agent が残っている（停止した Orchestrator が起動した等）。停止を求め、停止を確認した後の周回で再試行する。
      if (decision.terminate) {
        this.terminate(decision.terminate.pid, decision.terminate.signal);
        this.log("dispatch_terminating", { key: dispatch.key, pid: decision.terminate.pid, signal: decision.terminate.signal });
      }
      // 実行中のまま上限に達した記録（lease 切れ・停止）は、打ち切りとして確定させる。
      if (record?.status === "running" && decision.reason.startsWith("gave up")) {
        this.store.set(dispatch.key, finishRecord(record.attempt, { ok: false, error: decision.reason }, now, this.policy));
      }
      return decision.reason;
    }
    if (this.running.size >= this.config.maxConcurrent) return "max concurrent launches reached";

    // 起動前に実行中として記録する。記録後・起動前に停止しても、再起動後は停止した試行として回収される。
    const base = { status: "running" as const, attempt: decision.attempt, startedAt: now, leaseExpiresAt: now + this.config.leaseMs, ownerPid: process.pid };
    this.store.set(dispatch.key, { ...base, childPid: null });
    const launched = this.launcher.launch(dispatch, command, {
      serverUrl: this.config.serverUrl,
      attempt: decision.attempt,
      timeoutMs: this.config.leaseMs,
    });
    this.store.set(dispatch.key, { ...base, childPid: launched.pid });
    // PID を記録してから Role のコマンドを始める。記録前に停止すると Agent はコマンドを実行せずに終わるため、
    // PID の無い記録を回収して次の試行を起動しても、同じ dispatch を同時に動かさない。
    launched.start();
    report.launched.push(dispatch);
    this.log("dispatch_launched", {
      key: dispatch.key,
      role: dispatch.role,
      projectId: dispatch.projectId,
      subject: dispatch.subject,
      attempt: decision.attempt,
      ...(decision.recovered ? { recovered: decision.recovered } : {}),
    });
    const finished = launched.done.then((result) => {
      this.store.set(dispatch.key, finishRecord(decision.attempt, result, this.clock(), this.policy));
      this.running.delete(dispatch.key);
      this.log(result.ok ? "dispatch_succeeded" : "dispatch_failed", {
        key: dispatch.key,
        attempt: decision.attempt,
        ...(result.ok ? {} : { error: result.error }),
      });
    });
    this.running.set(dispatch.key, finished);
    return null;
  }
}
