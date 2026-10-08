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

  /** scope内のいずれかのGrant（activeRoleの指定時はそのRoleのGrant）を要求する参照用の検査。Grant無しはFORBIDDEN。 */
  async requireAnyRole(principal: Principal, scope: RoleScope): Promise<string> {
    if (principal === null) throw new UnauthenticatedError();
    if (this.activeRole !== null) return this.requireRole(principal, scope, this.activeRole);
    const granted = scope.kind === "workspace"
      ? (await this.workspaceGrants.listWorkspaceIds(principal)).includes(scope.id)
      : await this.projectGrants.hasAnyRole(scope.id, principal);
    if (!granted) throw new ForbiddenError("Principal does not have any Role Grant in this scope", scopeDetails(scope));
    return principal;
  }

  /**
   * Human管理操作（trusted-localのMCPだけに登録）の職務分離。WorkspaceのDirection Role Grantを持つPrincipalと、
   * activeRoleに固定した操作Contextを拒否する。Principalなし・Grantなしは通す（管理面との互換）。
   */
  async requireNoWorkspaceRole(principal: Principal, workspaceId: string): Promise<void> {
    if (principal === null) {
      if (this.activeRole !== null) throw new UnauthenticatedError();
      return;
    }
    if (this.activeRole !== null) {
      throw new ForbiddenError("A Workspace Direction role is not allowed to perform this operation", { workspaceId, activeRole: this.activeRole });
    }
    await this.requireNoWorkspaceGrant(principal, workspaceId);
  }

  /** Workspace所有のDirection Role Grantを持つPrincipalを拒否する（activeRoleは問わない）。Project管理操作の職務分離に使う。 */
  async requireNoWorkspaceGrant(principal: Principal, workspaceId: string): Promise<void> {
    if (principal === null) return;
    if ((await this.workspaceGrants.listWorkspaceIds(principal)).includes(workspaceId)) {
      throw new ForbiddenError("A Workspace Direction role is not allowed to perform this operation", { workspaceId });
    }
  }
}
