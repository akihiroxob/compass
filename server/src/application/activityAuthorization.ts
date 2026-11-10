import { projectRoles, type ProjectAuthorizationService, type ProjectRole, type RoleScopeAuthorizationService } from "@compass/access";
import { type ActivityAuthorizationPort, type ActivityTarget } from "@compass/activity";

import { ValidationError } from "@compass/shared";

const isProjectRole = (role: string): role is ProjectRole => (projectRoles as readonly string[]).includes(role);

/**
 * ActivityのAgent認可（activeRoleの固定を含む）。ProjectはAccessのProject Role Grant、WorkspaceはWorkspace Role Grantで検査し、
 * 互いに継承・合算しない。Workspace scopeではExecution Role、Project scopeでは新規発行できないDirection RoleのGrantを
 * Roleのscope検査で拒否する（Project scopeの旧Direction Grantは`ProjectAuthorizationService`の移行経路のまま）。
 */
export const activityAuthorization = (
  projectAuthorization: ProjectAuthorizationService,
  roleScopeAuthorization: RoleScopeAuthorizationService,
): ActivityAuthorizationPort => {
  const requireReader = (principal: string | null, target: ActivityTarget) =>
    target.kind === "workspace"
      ? roleScopeAuthorization.requireAnyRole(principal, target)
      : projectAuthorization.requireAnyRole(principal, target.id);
  return {
    requireReader,
    resolveActor: async (principal, target, role) => {
      if (role !== undefined) {
        if (!isProjectRole(role)) {
          throw new ValidationError("Activity input is invalid", [{ path: "role", message: `role must be one of ${projectRoles.join(", ")}` }]);
        }
        const principalId = target.kind === "workspace"
          ? await roleScopeAuthorization.requireRole(principal, target, role)
          : await projectAuthorization.requireRole(principal, target.id, role);
        return { principalId, role };
      }
      if (projectAuthorization.activeRole === null) return null;
      return { principalId: await requireReader(principal, target), role: projectAuthorization.activeRole };
    },
  };
};
