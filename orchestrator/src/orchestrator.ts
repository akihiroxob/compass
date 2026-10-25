import type { CompassStateReader } from "./compassClient.ts";
import type { OrchestratorConfig, RoleCommand, WorkspaceConfig } from "./config.ts";
import { decideLaunch, finishRecord, type DispatchPolicy, type DispatchStore } from "./dispatchStore.ts";
import { terminateAgent, type AgentLauncher } from "./launcher.ts";
import { planProjectConsultationDispatches, planWorkspaceDispatches, type WorkspaceDispatch } from "./plan.ts";

/** Operational Log。stdout / stderr へ出す実行記録で、Compass の Activity・Change Log には書かない。 */
export type OperationalLog = (event: string, fields: Record<string, unknown>) => void;

export const jsonLog: OperationalLog = (event, fields) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

export type TickReport = {
  launched: WorkspaceDispatch[];
  skipped: { key: string; reason: string }[];
  failedWorkspaces: { workspaceId: string; error: string }[];
};

/**
 * 設定した Workspace ごとに現在状態を Workspace Runtime Credential で読み、起動すべき専門 Role を起動する。判断は
 * `planWorkspaceDispatches` の明示的な状態判定だけで、知的判断は起動された Role に委ねる。起動の重複は dispatch key の記録
 * （`DispatchStore`）で抑止する。Workspace Role の Agent には Workspace の `agentEnv`、manager の Agent には Target Project の
 * `agentEnv` を加え、scope の違う Agent Credential を混ぜない。
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
    const report: TickReport = { launched: [], skipped: [], failedWorkspaces: [] };
    for (const workspace of this.config.workspaces) {
      let planned: WorkspaceDispatch[];
      try {
        planned = planWorkspaceDispatches(await this.reader.getWorkspaceOrchestrationState(workspace.workspaceId, workspace.token));
      } catch (error) {
        // 状態を読めない Workspace は起動も記録の整理もしない（次の周回で読み直す）。
        const message = (error as Error).message;
        report.failedWorkspaces.push({ workspaceId: workspace.workspaceId, error: message });
        this.log("state_read_failed", { workspaceId: workspace.workspaceId, error: message });
        continue;
      }
      // Project相談はIntent/Outcomeの有無から独立して読む。失敗したProjectの記録はpruneしない。
      let projectReadFailed = false;
      for (const project of workspace.projects) {
        if (!project.token) continue;
        try {
          if (!this.reader.getProjectConsultationState) throw new Error("Project consultation state reader is unavailable");
          const state = await this.reader.getProjectConsultationState(project.projectId, project.token);
          if (state.workspaceId !== workspace.workspaceId || state.projectId !== project.projectId) throw new Error("Project consultation scope mismatch");
          planned.push(...planProjectConsultationDispatches(state));
        } catch (error) {
          projectReadFailed = true;
          this.log("project_consultation_state_failed", { projectId: project.projectId, error: (error as Error).message });
          report.failedWorkspaces.push({ workspaceId: workspace.workspaceId, error: `Project ${project.projectId}: ${(error as Error).message}` });
        }
      }
      if (!projectReadFailed) this.store.prune(workspace.workspaceId, planned);
      for (const dispatch of planned) {
        const skipped = this.tryLaunch(workspace, dispatch, report);
        if (skipped) {
          report.skipped.push({ key: dispatch.key, reason: skipped });
          this.log("dispatch_skipped", { key: dispatch.key, role: dispatch.role, reason: skipped });
        }
      }
    }
    for (const project of this.config.consultationProjects ?? []) {
      try {
        if (!this.reader.getProjectConsultationState) throw new Error("Project consultation state reader is unavailable");
        const state = await this.reader.getProjectConsultationState(project.projectId, project.token);
        if (state.projectId !== project.projectId) throw new Error("Project consultation scope mismatch");
        for (const dispatch of planProjectConsultationDispatches(state)) {
          const skipped = this.tryLaunch(null, dispatch, report);
          if (skipped) report.skipped.push({ key: dispatch.key, reason: skipped });
        }
      } catch (error) {
        this.log("project_consultation_state_failed", { projectId: project.projectId, error: (error as Error).message });
        report.failedWorkspaces.push({ workspaceId: `project:${project.projectId}`, error: (error as Error).message });
      }
    }
    return report;
  }

  /** 起動した Agent がすべて終わるまで待つ（`--once` と停止時に使う）。 */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  /**
   * 起動する Role のコマンドに scope の `agentEnv` を合わせる。manager は設定に無い Project では起動しない（Workspace の設定で代用しない）。
   * 起動しない理由を文字列で返す。
   */
  private commandOf(workspace: WorkspaceConfig | null, dispatch: WorkspaceDispatch): RoleCommand | string {
    const command = this.config.roles[dispatch.role];
    if (!command) return `no command is configured for the ${dispatch.role} Role`;
    if (dispatch.projectId === null) return { command: command.command, env: { ...command.env, ...workspace?.agentEnv } };
    const project = (this.config.consultationProjects ?? []).find(({ projectId }) => projectId === dispatch.projectId) ?? workspace?.projects.find(({ projectId }) => projectId === dispatch.projectId);
    if (!project) return `Project ${dispatch.projectId} is not configured in workspaces[].projects`;
    return { command: command.command, env: { ...command.env, ...project.agentEnv } };
  }

  private tryLaunch(workspace: WorkspaceConfig | null, dispatch: WorkspaceDispatch, report: TickReport): string | null {
    const command = this.commandOf(workspace, dispatch);
    if (typeof command === "string") return command;
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
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      subject: dispatch.subject,
      attempt: decision.attempt,
      ...(decision.recovered ? { recovered: decision.recovered } : {}),
    });
    const finished = launched.done.then(async (result) => {
      if (result.ok && dispatch.subject.kind === "consultation") {
        // process成功だけではHuman返信を処理済みにしない。現在状態が進んだことを確認する。
        const project = (this.config.consultationProjects ?? []).find(({ projectId }) => projectId === dispatch.projectId) ?? workspace?.projects.find(({ projectId }) => projectId === dispatch.projectId);
        try {
          if (!project?.token || !this.reader.getProjectConsultationState) throw new Error("Project consultation state reader is unavailable");
          const state = await this.reader.getProjectConsultationState(project.projectId, project.token);
          if (state.consultations.some(({ id, inputRevision }) => id === dispatch.subject.id && inputRevision === dispatch.subject.inputRevision)) {
            result = { ok: false, error: "Agent exited without handling the pending Human input" };
          }
        } catch (error) { result = { ok: false, error: (error as Error).message }; }
      }
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
