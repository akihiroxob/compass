import { projectGrantRoles, workspaceGrantRoles, type AgentRole } from "../grant/model.ts";

export type McpConnectionScope = { kind: "workspace" | "project"; id: string };
export const mcpConnectionRoles = (kind: McpConnectionScope["kind"]): readonly AgentRole[] =>
  kind === "workspace" ? workspaceGrantRoles : projectGrantRoles;
export const mcpConnectionUrl = (origin: string) => new URL("/mcp", origin).href;

/** tokenの入力・保存は行わず、接続先とRoleだけを埋めた設定例を作る。 */
export const mcpConnectionExample = (origin: string, role: AgentRole) => JSON.stringify({
  mcpServers: { compass: { url: mcpConnectionUrl(origin), headers: {
    Authorization: "Bearer <AGENT_CREDENTIAL>", "X-Compass-Active-Role": role,
  } } },
}, null, 2);

export const mcpConnectionCheck = (scope: McpConnectionScope, role: AgentRole) => JSON.stringify({
  tool: scope.kind === "workspace" ? "get_workspace_role_context" : "get_role_context",
  arguments: { [scope.kind === "workspace" ? "workspaceId" : "projectId"]: scope.id, role },
}, null, 2);
