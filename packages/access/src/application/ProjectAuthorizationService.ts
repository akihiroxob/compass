import type { ProjectRole } from "../domain/ProjectRole.ts";
import type { ProjectGrantRepository } from "../domain/ProjectGrantRepository.ts";
import { ForbiddenError, UnauthenticatedError } from "@compass/shared";

/** 呼び出し主体。Bearerから解決した値で、request bodyやtool入力・MCP session IDからは得ない。Principalなしはnull。 */
export type Principal = string | null;

/**
 * Project scopeのRole Grantによる認可。検査は毎回Repositoryを読むため、Grantの取消は次の呼び出しから即時に反映される。
 * Projectの存在確認より先に呼び、Grantを持たないPrincipalへProjectの存在有無を漏らさない。
 */
export class ProjectAuthorizationService {
  constructor(
    private readonly projectGrantRepository: ProjectGrantRepository,
    /**
     * 操作Contextに固定したRole（`X-Compass-Active-Role`）。nullは互換の「操作ごとに必要Roleを検査」。
     * 指定時は`principalId + projectId + activeRole`のGrantだけで認可し、同じPrincipalの他Grantを合算しない。
     */
    private readonly activeRole: ProjectRole | null = null,
  ) {}

  /** 同じRepositoryで、認可をactiveRoleのGrantだけに固定したserviceを返す。 */
  forActiveRole(activeRole: ProjectRole): ProjectAuthorizationService {
    return new ProjectAuthorizationService(this.projectGrantRepository, activeRole);
  }

  /** 操作ContextがactiveRoleに固定されているか。固定時はtrusted-localでもProject参照にGrantを要求する。 */
  get hasActiveRole(): boolean {
    return this.activeRole !== null;
  }

  /** activeRoleのGrantを要求する。activeRoleが無ければ何もしない。 */
  private async requireActiveRoleGrant(principal: string, projectId: string): Promise<void> {
    if (this.activeRole === null) return;
    if (!(await this.projectGrantRepository.hasRole(projectId, principal, this.activeRole))) {
      throw new ForbiddenError(`Principal does not have the active ${this.activeRole} role in this Project`, {
        activeRole: this.activeRole,
        projectId,
      });
    }
  }

  /** PrincipalなしはUNAUTHENTICATED。Grant無し（別Project・取消済み・未発行・存在しないProject）はすべてFORBIDDEN。 */
  async requireRole(principal: Principal, projectId: string, role: ProjectRole): Promise<string> {
    if (principal === null) throw new UnauthenticatedError();
    if (this.activeRole !== null && this.activeRole !== role) {
      throw new ForbiddenError(`The active ${this.activeRole} role cannot perform an operation of the ${role} role`, {
        requiredRole: role,
        activeRole: this.activeRole,
        projectId,
      });
    }
    if (!(await this.projectGrantRepository.hasRole(projectId, principal, role))) {
      throw new ForbiddenError(`Principal does not have the ${role} role in this Project`, {
        requiredRole: role,
        projectId,
      });
    }
    return principal;
  }

  /** いずれかのRole Grant（activeRoleの指定時はそのRoleのGrant）を要求する（remote modeのDirection参照tool）。Grant無しはFORBIDDEN。 */
  async requireAnyRole(principal: Principal, projectId: string): Promise<string> {
    if (principal === null) throw new UnauthenticatedError();
    if (this.activeRole !== null) {
      await this.requireActiveRoleGrant(principal, projectId);
      return principal;
    }
    if (!(await this.projectGrantRepository.hasAnyRole(projectId, principal))) {
      throw new ForbiddenError("Principal does not have any Role Grant in this Project", { projectId });
    }
    return principal;
  }

  /** いずれかのRole Grant（activeRoleの指定時はそのRoleのGrant）を持つProjectのID（remote modeの`list_projects`）。 */
  async listGrantedProjectIds(principal: Principal): Promise<string[]> {
    if (principal === null) throw new UnauthenticatedError();
    return this.projectGrantRepository.listProjectIds(principal, this.activeRole ?? undefined);
  }

  /**
   * 職務分離の誤用防止。そのRoleのGrantを持つPrincipalだけを拒否し、Principalなし・Grantなしは通す（管理面との互換）。
   * Agent名を変えれば回避できるため、trusted-localでは構造上の保証（Role用toolに該当操作が無いこと）が本体になる。
   */
  async requireNotRole(principal: Principal, projectId: string, role: ProjectRole): Promise<void> {
    // activeRoleの指定時は、activeRoleのGrantも要求する。職務分離は緩めず、他Grantによる拒否は従来どおり行う。
    if (principal !== null) await this.requireActiveRoleGrant(principal, projectId);
    if (principal !== null && (await this.projectGrantRepository.hasRole(projectId, principal, role))) {
      throw new ForbiddenError(`The ${role} role is not allowed to perform this operation`, {
        requiredRole: role,
        projectId,
      });
    }
  }

  /** 検査を通ってから操作を実行する。MCPのhandlerはPrincipalを渡すだけで、検査の規則を持たない。 */
  async asRole<T>(principal: Principal, projectId: string, role: ProjectRole, operation: () => Promise<T>) {
    await this.requireRole(principal, projectId, role);
    return operation();
  }

  async unlessRole<T>(principal: Principal, projectId: string, role: ProjectRole, operation: () => Promise<T>) {
    await this.requireNotRole(principal, projectId, role);
    return operation();
  }
}
