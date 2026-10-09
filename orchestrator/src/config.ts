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

/** scope（Workspace / Project）ごとに Agent へ加える環境変数。その scope の Agent Credential を使う MCP 設定 file の path 等を渡す。 */
const agentEnvSchema = z.record(z.string(), z.string()).default({});

const configSchema = z.strictObject({
  serverUrl: z.url(),
  /** 起動記録と process lock を置く directory。設定 file からの相対 path。 */
  stateDir: z.string().trim().min(1).default(".compass-orchestrator"),
  intervalMs: z.number().int().min(1000).default(60_000),
  /** 1回の起動の上限時間。超えると Agent を停止し、失敗した試行として扱う。 */
  leaseMs: z.number().int().min(1000).default(30 * 60_000),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  retryBackoffMs: z.number().int().min(0).default(60_000),
  maxConcurrent: z.number().int().min(1).max(20).default(2),
  /** lease 切れ・timeout で Agent を停止するとき、SIGTERM から SIGKILL へ切り替えるまでの猶予。 */
  terminateGraceMs: z.number().int().min(0).default(10_000),
  workspaces: z
    .array(
      z.strictObject({
        workspaceId: z.string().trim().min(1),
        /** Server への Bearer（Workspace Runtime Credential、scope `runtime:state:read`）を読む環境変数名。 */
        tokenEnv: z.string().trim().min(1),
        /** Workspace Role（strategist / researcher / evaluator）の Agent へ加える環境変数。Workspace の Agent Credential を使う設定を渡す。 */
        agentEnv: agentEnvSchema,
        /** manager を起動する Project。ここに無い Target Project の manager は起動しない（Workspace の Credential で代用しない）。 */
        projects: z
          .array(
            z.strictObject({
              projectId: z.string().trim().min(1),
              /** その Project の manager の Agent へ加える環境変数。Project の Agent Credential を使う設定を渡す。 */
              agentEnv: agentEnvSchema,
            }),
          )
          .default([]),
      }),
    )
    .min(1),
  roles: z.partialRecord(z.enum(dispatchRoles as [DispatchRole, ...DispatchRole[]]), roleCommandSchema),
});

export type RoleCommand = z.infer<typeof roleCommandSchema>;

type ParsedConfig = z.infer<typeof configSchema>;

export type WorkspaceConfig = ParsedConfig["workspaces"][number] & { token: string };

export type OrchestratorConfig = Omit<ParsedConfig, "workspaces"> & { workspaces: WorkspaceConfig[] };

export class ConfigError extends Error {}

/** Project 単位の旧設定（`projects[]`）。Workspace 単位の設定へ書き換える手順を示して拒否する。 */
const legacyProjectConfigMessage =
  "projects[] (Project-based orchestration) is no longer supported. Replace it with workspaces[]: set workspaceId to the Project's " +
  "Workspace (get_project returns workspaceId), set tokenEnv to a variable holding a Workspace Runtime Credential with the " +
  "runtime:state:read scope (a Project Runtime Credential cannot read the Workspace state), and list each Project whose manager the " +
  "Orchestrator starts in workspaces[].projects with the agentEnv of that Project's manager Credential. See orchestrator/README.md";

/** Orchestrator の Credential の環境変数名を、Agent へ渡す環境変数の名前として設定していないか。 */
const assertNoCredentialEnv = (credentialEnv: ReadonlySet<string>, path: string, env: Record<string, string>) => {
  const leaked = Object.keys(env).filter((name) => credentialEnv.has(name));
  if (leaked.length > 0) throw new ConfigError(`${path} must not set the orchestrator credential variables: ${leaked.join(", ")}`);
};

/**
 * 設定 file（JSON）を読み、Credential を環境変数から解決する。token の値は設定 file にもログにも書かない。
 * Role の `env`・scope の `agentEnv` で Credential の環境変数名を上書きすることは許さない（Orchestrator の Credential を Agent へ渡さない）。
 */
export const loadConfig = (path: string, env: NodeJS.ProcessEnv = process.env): OrchestratorConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Cannot read the config file ${path}: ${(error as Error).message}`);
  }
  if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "projects")) {
    throw new ConfigError(`Invalid config ${path}: ${legacyProjectConfigMessage}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const duplicated = (ids: string[]) => ids.find((id, index) => ids.indexOf(id) !== index);
  const workspaceDuplicate = duplicated(parsed.data.workspaces.map(({ workspaceId }) => workspaceId));
  if (workspaceDuplicate) throw new ConfigError(`Workspace ${workspaceDuplicate} is listed more than once in workspaces[]`);
  const projectDuplicate = duplicated(parsed.data.workspaces.flatMap(({ projects }) => projects.map(({ projectId }) => projectId)));
  if (projectDuplicate) throw new ConfigError(`Project ${projectDuplicate} is listed more than once in workspaces[].projects`);

  const workspaces = parsed.data.workspaces.map((workspace) => {
    const token = env[workspace.tokenEnv]?.trim();
    if (!token) throw new ConfigError(`The environment variable ${workspace.tokenEnv} for Workspace ${workspace.workspaceId} is not set`);
    return { ...workspace, token };
  });
  const credentialEnv = new Set(workspaces.map(({ tokenEnv }) => tokenEnv));
  for (const [role, command] of Object.entries(parsed.data.roles)) assertNoCredentialEnv(credentialEnv, `roles.${role}.env`, command?.env ?? {});
  workspaces.forEach((workspace, index) => {
    assertNoCredentialEnv(credentialEnv, `workspaces[${index}].agentEnv`, workspace.agentEnv);
    workspace.projects.forEach((project, projectIndex) =>
      assertNoCredentialEnv(credentialEnv, `workspaces[${index}].projects[${projectIndex}].agentEnv`, project.agentEnv),
    );
  });
  return { ...parsed.data, stateDir: resolve(dirname(path), parsed.data.stateDir), workspaces };
};

/** Agent へ渡さない Orchestrator の Credential の環境変数名（すべての Workspace の `tokenEnv`）。 */
export const credentialEnvOf = (config: Pick<OrchestratorConfig, "workspaces">): string[] =>
  config.workspaces.map(({ tokenEnv }) => tokenEnv);
