import { projectRoles, type ProjectRole, type RoleScopeAuthorizationService } from "@compass/access";

import { consultationResponderRole, type ConsultationAgentAuthorization, type ConsultationScope } from "@compass/collaboration";

import { ValidationError } from "@compass/shared";

const isProjectRole = (role: string): role is ProjectRole => (projectRoles as readonly string[]).includes(role);

/**
 * 相談のAgent認可（activeRoleの固定を含む）。相談のscopeのRole Grantだけで認可する。ProjectはExecution Role（manager / worker / reviewer）、
 * WorkspaceはDirection Role（strategist / researcher / evaluator）で、WorkspaceとProjectの間・旧Project Direction Grant・他scopeのGrantでは
 * 参照・記録させない。結論整理・取消はscopeの応答Role（ProjectはManager、WorkspaceはStrategist）。
 */
export const consultationAgentAuthorization = (roleScopeAuthorization: RoleScopeAuthorizationService): ConsultationAgentAuthorization => {
  const roleScope = (scope: ConsultationScope) =>
    scope.kind === "project" ? { kind: "project" as const, id: scope.projectId } : { kind: "workspace" as const, id: scope.workspaceId };
  return {
    requireReader: async (principal, scope) => (await roleScopeAuthorization.requireScopedRole(principal, roleScope(scope))).principalId,
    resolveActor: async (principal, scope, role) => {
      const actorRole = role ?? roleScopeAuthorization.activeRole;
      if (actorRole === null || actorRole === undefined) return null;
      if (!isProjectRole(actorRole)) {
        throw new ValidationError("Consultation input is invalid", [{ path: "role", message: `role must be one of ${projectRoles.join(", ")}` }]);
      }
      // scopeに属さないRole（Project相談のstrategist、Workspace相談のworker等）はGrantの有無によらずFORBIDDEN。
      const principalId = await roleScopeAuthorization.requireRole(principal, roleScope(scope), actorRole);
      return { kind: "agent", principalId, role: actorRole };
    },
    requireResponder: async (principal, scope) => {
      const role = consultationResponderRole(scope.kind);
      return { kind: "agent", principalId: await roleScopeAuthorization.requireRole(principal, roleScope(scope), role), role };
    },
    requireProjectManager: async (principal, projectId) => ({
      kind: "agent",
      principalId: await roleScopeAuthorization.requireRole(principal, { kind: "project", id: projectId }, "manager"),
      role: "manager",
    }),
    listReadableProjectIds: (principal) => roleScopeAuthorization.listScopedProjectIds(principal),
  };
};
