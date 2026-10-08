import type { ProjectRole } from "./ProjectRole.ts";

export const workspaceRoles = ["strategist", "researcher", "evaluator"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const executionRoles = ["manager", "worker", "reviewer"] as const;
export type ExecutionRole = (typeof executionRoles)[number];
export type RoleScope = { kind: "workspace" | "project"; id: string };

/** RuntimeはAgent Role-scope認可ではなくCredentialのscopeで扱う。 */
export const isRoleInScope = (kind: RoleScope["kind"], role: ProjectRole): boolean =>
  (kind === "workspace" ? workspaceRoles : executionRoles).some((candidate) => candidate === role);
