import { spawn } from "node:child_process";
import type { RoleCommand } from "./config.ts";
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

/** Role ごとの shell コマンドを子プロセスとして起動する。timeout を過ぎたら process group ごと停止する。 */
export class ShellAgentLauncher implements AgentLauncher {
  launch(dispatch: Dispatch, command: RoleCommand, context: { serverUrl: string; attempt: number; timeoutMs: number }): Launched {
    const detached = process.platform !== "win32";
    const child = spawn(command.command, {
      shell: true,
      stdio: "inherit",
      detached,
      env: {
        ...process.env,
        ...command.env,
        COMPASS_SERVER_URL: context.serverUrl,
        COMPASS_PROJECT_ID: dispatch.projectId,
        COMPASS_ROLE: dispatch.role,
        COMPASS_SUBJECT_KIND: dispatch.subject.kind,
        COMPASS_SUBJECT_ID: dispatch.subject.id,
        COMPASS_DISPATCH_KEY: dispatch.key,
        COMPASS_DISPATCH_ATTEMPT: String(context.attempt),
        COMPASS_PROMPT: buildPrompt(dispatch),
      },
    });
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (detached) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // 既に終了している。
      }
    };
    const done = new Promise<LaunchResult>((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, context.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `failed to start: ${error.message}` });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) resolve({ ok: false, error: `timed out after ${context.timeoutMs}ms` });
        else if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: signal ? `terminated by ${signal}` : `exited with code ${code}` });
      });
    });
    return { pid: child.pid ?? null, done };
  }
}
