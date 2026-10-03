import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { dispatchRoles, type DispatchRole } from "./plan.ts";

const roleCommandSchema = z.object({
  /** shell で実行する Agent の起動コマンド。prompt・対象は環境変数で渡す（`COMPASS_PROMPT` 等）。 */
  command: z.string().trim().min(1),
  /** 起動時に追加する環境変数（Role ごとの MCP 設定 file の path 等）。Credential は値ではなく環境変数経由で渡す。 */
  env: z.record(z.string(), z.string()).default({}),
});

const configSchema = z.object({
  serverUrl: z.url(),
  /** 起動記録と process lock を置く directory。設定 file からの相対 path。 */
  stateDir: z.string().trim().min(1).default(".compass-orchestrator"),
  intervalMs: z.number().int().min(1000).default(60_000),
  /** 1回の起動の上限時間。超えると Agent を停止し、失敗した試行として扱う。 */
  leaseMs: z.number().int().min(1000).default(30 * 60_000),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  retryBackoffMs: z.number().int().min(0).default(60_000),
  maxConcurrent: z.number().int().min(1).max(20).default(2),
  projects: z
    .array(
      z.object({
        projectId: z.string().trim().min(1),
        /** Server への Bearer（Runtime Credential、trusted-local では runtime Grant を持つ名前）を読む環境変数名。 */
        tokenEnv: z.string().trim().min(1),
      }),
    )
    .min(1),
  roles: z.partialRecord(z.enum(dispatchRoles as [DispatchRole, ...DispatchRole[]]), roleCommandSchema),
});

export type RoleCommand = z.infer<typeof roleCommandSchema>;

export type OrchestratorConfig = Omit<z.infer<typeof configSchema>, "projects"> & {
  projects: { projectId: string; token: string }[];
};

export class ConfigError extends Error {}

/**
 * 設定 file（JSON）を読み、Credential を環境変数から解決する。token の値は設定 file にもログにも書かない。
 */
export const loadConfig = (path: string, env: NodeJS.ProcessEnv = process.env): OrchestratorConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Cannot read the config file ${path}: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const projects = parsed.data.projects.map(({ projectId, tokenEnv }) => {
    const token = env[tokenEnv]?.trim();
    if (!token) throw new ConfigError(`The environment variable ${tokenEnv} for Project ${projectId} is not set`);
    return { projectId, token };
  });
  return { ...parsed.data, stateDir: resolve(dirname(path), parsed.data.stateDir), projects };
};
