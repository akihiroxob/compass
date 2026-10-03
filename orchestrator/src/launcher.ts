import { spawn } from "node:child_process";
import type { RoleCommand } from "./config.ts";
import { agentProcessGroup, isAgentAlive } from "./dispatchStore.ts";
import type { Dispatch } from "./plan.ts";

export type LaunchResult = { ok: true } | { ok: false; error: string };

export type Launched = { pid: number | null; done: Promise<LaunchResult> };

export interface AgentLauncher {
  launch(dispatch: Dispatch, command: RoleCommand, context: { serverUrl: string; attempt: number; timeoutMs: number }): Launched;
}

/**
 * 起動する Agent へ渡す指示。対象の特定だけを伝え、Role の手順・判断基準は含めない（Agent が `get_role_context` で取得する）。
 */
export const buildPrompt = (dispatch: Dispatch): string =>
  [
    `Compass の ${dispatch.role} Role として起動された。`,
    `projectId: ${dispatch.projectId}`,
    `対象: ${dispatch.subject.kind} ${dispatch.subject.id}`,
    `起動理由: ${dispatch.reason}`,
    `MCP の get_role_context({ projectId: "${dispatch.projectId}", role: "${dispatch.role}" }) で Role Context を取得し、その指示に従って対象を処理する。`,
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

/**
 * Agent へ渡す環境変数。親の環境変数から Orchestrator の Credential（`projects[].tokenEnv`）を除き、
 * Role の `env` と対象の指定を加える。Agent の Credential は Role ごとの Principal で Agent 側に持たせる。
 */
export const buildAgentEnv = (
  parentEnv: NodeJS.ProcessEnv,
  credentialEnv: readonly string[],
  dispatch: Dispatch,
  command: RoleCommand,
  context: { serverUrl: string; attempt: number },
): NodeJS.ProcessEnv => {
  const excluded = new Set(credentialEnv);
  return {
    ...Object.fromEntries(Object.entries(parentEnv).filter(([name]) => !excluded.has(name))),
    ...Object.fromEntries(Object.entries(command.env).filter(([name]) => !excluded.has(name))),
    COMPASS_SERVER_URL: context.serverUrl,
    COMPASS_PROJECT_ID: dispatch.projectId,
    COMPASS_ROLE: dispatch.role,
    COMPASS_SUBJECT_KIND: dispatch.subject.kind,
    COMPASS_SUBJECT_ID: dispatch.subject.id,
    COMPASS_DISPATCH_KEY: dispatch.key,
    COMPASS_DISPATCH_ATTEMPT: String(context.attempt),
    COMPASS_PROMPT: buildPrompt(dispatch),
  };
};

/**
 * Role ごとの shell コマンドを子プロセスとして起動する。timeout を過ぎたら process group ごと SIGTERM で停止し、
 * `terminateGraceMs` 後も残っていれば SIGKILL する。
 */
export class ShellAgentLauncher implements AgentLauncher {
  constructor(
    private readonly options: { credentialEnv: readonly string[]; terminateGraceMs: number; parentEnv?: NodeJS.ProcessEnv },
  ) {}

  launch(dispatch: Dispatch, command: RoleCommand, context: { serverUrl: string; attempt: number; timeoutMs: number }): Launched {
    const child = spawn(command.command, {
      shell: true,
      stdio: "inherit",
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
    return { pid: child.pid ?? null, done };
  }
}
