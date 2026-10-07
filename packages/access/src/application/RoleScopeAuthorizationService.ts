import { ForbiddenError, UnauthenticatedError } from "@compass/shared";
import type { ProjectRole } from "../domain/ProjectRole.ts";
import type { ProjectGrantRepository } from "../domain/ProjectGrantRepository.ts";
import type { WorkspaceGrantRepository } from "../domain/WorkspaceGrant.ts";
import { isRoleInScope, type RoleScope, type WorkspaceRole } from "../domain/RoleScope.ts";
import type { Principal } from "./ProjectAuthorizationService.ts";

const scopeDetails = (scope: RoleScope) => scope.kind === "workspace"
  ? { workspaceId: scope.id } : { projectId: scope.id };

/** 明示scopeの認可。Roleの合算やWorkspace/Project間の継承をしない。 */
export class RoleScopeAuthorizationService {
  constructor(
    private readonly workspaceGrants: WorkspaceGrantRepository,
    private readonly projectGrants: ProjectGrantRepository,
    readonly activeRole: ProjectRole | null = null,
  ) {}
  forActiveRole(role: ProjectRole): RoleScopeAuthorizationService {
    return new RoleScopeAuthorizationService(this.workspaceGrants, this.projectGrants, role);
  }
  async requireRole(principal: Principal, scope: RoleScope, role: ProjectRole): Promise<string> {
    if (principal === null) throw new UnauthenticatedError();
    if (!isRoleInScope(scope.kind, role) || (this.activeRole !== null && this.activeRole !== role)) {
      throw new ForbiddenError("Role does not match the operation scope or activeRole", {
        ...scopeDetails(scope), requiredRole: role, activeRole: this.activeRole ?? undefined,
      });
    }
    const granted = scope.kind === "workspace"
      ? await this.workspaceGrants.hasRole(scope.id, principal, role as WorkspaceRole)
      : await this.projectGrants.hasRole(scope.id, principal, role);
    if (!granted) throw new ForbiddenError("Principal does not have the required Role Grant in this scope", {
      ...scopeDetails(scope), requiredRole: role,
    });
    return principal;
  }
  async asRole<T>(principal: Principal, scope: RoleScope, role: ProjectRole, operation: () => Promise<T>): Promise<T> {
    await this.requireRole(principal, scope, role);
    return operation();
  }
}
