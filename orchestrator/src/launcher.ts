import { spawn } from "node:child_process";
import type { RoleCommand } from "./config.ts";
import { agentProcessGroup, isAgentAlive } from "./dispatchStore.ts";
import type { WorkspaceDispatch } from "./plan.ts";

export type LaunchResult = { ok: true } | { ok: false; error: string };

/**
 * 起動した Agent。`start()` を呼ぶまで Role のコマンドは実行されない。呼出側は PID を記録してから `start()` する。
 * 呼ぶ前に Orchestrator が停止した場合、Agent は Role のコマンドを実行せずに終了する。
 */
export type Launched = { pid: number | null; done: Promise<LaunchResult>; start(): void };

export interface AgentLauncher {
  launch(dispatch: WorkspaceDispatch, command: RoleCommand, context: { serverUrl: string; attempt: number; timeoutMs: number }): Launched;
}

/** Role Context の取得方法。Workspace Role は Workspace、manager は Target の Project を scope にする。 */
const roleContextCall = (dispatch: WorkspaceDispatch) =>
  dispatch.projectId === null
    ? `get_workspace_role_context({ workspaceId: "${dispatch.workspaceId}", role: "${dispatch.role}" })`
    : `get_role_context({ projectId: "${dispatch.projectId}", role: "${dispatch.role}" })`;

/**
 * 起動する Agent へ渡す指示。対象の特定だけを伝え、Role の手順・判断基準は含めない（Agent が Role Context で取得する）。
 */
export const buildPrompt = (dispatch: WorkspaceDispatch): string =>
  [
    `Compass の ${dispatch.role} Role として起動された。`,
    `workspaceId: ${dispatch.workspaceId}`,
    ...(dispatch.projectId === null ? [] : [`projectId: ${dispatch.projectId}`]),
    `対象: ${dispatch.subject.kind} ${dispatch.subject.id}`,
    `起動理由: ${dispatch.reason}`,
    `MCP の ${roleContextCall(dispatch)} で Role Context を取得し、その指示に従って対象を処理する。`,
  ].join("\n");

/**
 * 起動した Agent を停止する。Agent は自身の process group の leader として起動するため、group ごと停止する
 * （shell 経由で起動した孫プロセスも残さない）。既に終了していれば何もしない。
 */
export const terminateAgent = (pid: number, signal: NodeJS.Signals): void => {
  try {
    if (agentProcessGroup) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // 既に終了している。
  }
};

/** Orchestrator が対象の指定として Agent へ渡す環境変数。親・Role の `env` の同名の値は使わない。 */
const dispatchEnvNames = [
  "COMPASS_SERVER_URL",
  "COMPASS_WORKSPACE_ID",
  "COMPASS_PROJECT_ID",
  "COMPASS_ROLE",
  "COMPASS_SUBJECT_KIND",
  "COMPASS_SUBJECT_ID",
  "COMPASS_DISPATCH_KEY",
  "COMPASS_DISPATCH_ATTEMPT",
  "COMPASS_PROMPT",
];

/**
 * Agent へ渡す環境変数。親の環境変数から Orchestrator の Credential（`workspaces[].tokenEnv`）と対象の指定（`COMPASS_*` の対象変数）を除き、
 * Role の `env`（scope の `agentEnv` を合わせたもの）と対象の指定を加える。Agent の Credential は Role・scope ごとの Principal で Agent 側に持たせる。
 * Workspace Role には `COMPASS_PROJECT_ID` を渡さない（Project ID を Workspace ID として扱わせない）。
 */
export const buildAgentEnv = (
  parentEnv: NodeJS.ProcessEnv,
  credentialEnv: readonly string[],
  dispatch: WorkspaceDispatch,
  command: RoleCommand,
  context: { serverUrl: string; attempt: number },
): NodeJS.ProcessEnv => {
  const excluded = new Set([...credentialEnv, ...dispatchEnvNames]);
  return {
    ...Object.fromEntries(Object.entries(parentEnv).filter(([name]) => !excluded.has(name))),
    ...Object.fromEntries(Object.entries(command.env).filter(([name]) => !excluded.has(name))),
    COMPASS_SERVER_URL: context.serverUrl,
    COMPASS_WORKSPACE_ID: dispatch.workspaceId,
    ...(dispatch.projectId === null ? {} : { COMPASS_PROJECT_ID: dispatch.projectId }),
    COMPASS_ROLE: dispatch.role,
    COMPASS_SUBJECT_KIND: dispatch.subject.kind,
    COMPASS_SUBJECT_ID: dispatch.subject.id,
    COMPASS_DISPATCH_KEY: dispatch.key,
    COMPASS_DISPATCH_ATTEMPT: String(context.attempt),
    COMPASS_PROMPT: buildPrompt(dispatch),
  };
};

/** 起動の gate を待たずに終了したときの終了コード（EX_TEMPFAIL）。 */
export const launchGateAbortedCode = 75;

/**
 * Role のコマンドの前に、Orchestrator からの開始合図を fd 3 で待つ shell script を付ける。
 * Orchestrator が合図の前に停止すると fd 3 が EOF になり、Role のコマンドを実行せずに終了する。
 */
export const gatedCommand = (command: string): string =>
  [`IFS= read -r compass_launch_gate <&3 || exit ${launchGateAbortedCode}`, "exec 3<&-", command].join("\n");

/**
 * Role ごとの shell コマンドを子プロセスとして起動する。PID を記録するまで Role のコマンドを始めないよう、
 * `start()` の合図を fd 3 で待たせる（Windows を除く）。timeout を過ぎたら process group ごと SIGTERM で停止し、
 * `terminateGraceMs` 後も残っていれば SIGKILL する。
 */
export class ShellAgentLauncher implements AgentLauncher {
  constructor(
    private readonly options: { credentialEnv: readonly string[]; terminateGraceMs: number; parentEnv?: NodeJS.ProcessEnv },
  ) {}

  launch(dispatch: WorkspaceDispatch, command: RoleCommand, context: { serverUrl: string; attempt: number; timeoutMs: number }): Launched {
    const child = spawn(agentProcessGroup ? gatedCommand(command.command) : command.command, {
      shell: true,
      stdio: agentProcessGroup ? ["inherit", "inherit", "inherit", "pipe"] : "inherit",
      detached: agentProcessGroup,
      env: buildAgentEnv(this.options.parentEnv ?? process.env, this.options.credentialEnv, dispatch, command, context),
    });
    const pid = child.pid;
    const done = new Promise<LaunchResult>((resolve) => {
      let timedOut = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        if (pid === undefined) return;
        timedOut = true;
        terminateAgent(pid, "SIGTERM");
        forceTimer = setTimeout(() => terminateAgent(pid, "SIGKILL"), this.options.terminateGraceMs);
      }, context.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `failed to start: ${error.message}` });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (!timedOut) {
          resolve(code === 0 ? { ok: true } : { ok: false, error: signal ? `terminated by ${signal}` : `exited with code ${code}` });
          return;
        }
        // shell が終わっても group 内の Agent が残り得る。猶予後の SIGKILL を待ち、group の停止を確認してから試行を終える。
        const settle = () => {
          if (isAgentAlive(pid!)) {
            setTimeout(settle, 100);
            return;
          }
          clearTimeout(forceTimer);
          resolve({ ok: false, error: `timed out after ${context.timeoutMs}ms` });
        };
        settle();
      });
    });
    const gate = agentProcessGroup ? (child.stdio[3] as NodeJS.WritableStream & { destroy(): void }) : null;
    // 合図の前に Agent が終了していれば書込は失敗する。結果は exit で扱う。
    gate?.on("error", () => {});
    return {
      pid: child.pid ?? null,
      done,
      start: () => {
        if (gate && pid !== undefined) gate.end("start\n");
      },
    };
  }
}
