import type { ProjectRole } from "../../constants/ProjectRole.ts";
import type { ProjectGrantRepository } from "../../domain/repository/ProjectGrantRepository.ts";
import { ForbiddenError } from "../error/ForbiddenError.ts";
import { UnauthenticatedError } from "../error/UnauthenticatedError.ts";

/** 呼び出し主体。Bearerから解決した値で、request bodyやtool入力・MCP session IDからは得ない。Principalなしはnull。 */
export type Principal = string | null;

/**
 * Project scopeのRole Grantによる認可。検査は毎回Repositoryを読むため、Grantの取消は次の呼び出しから即時に反映される。
 * Projectの存在確認より先に呼び、Grantを持たないPrincipalへProjectの存在有無を漏らさない。
 */
export class ProjectAuthorizationService {
  constructor(private readonly projectGrantRepository: ProjectGrantRepository) {}

  /** PrincipalなしはUNAUTHENTICATED。Grant無し（別Project・取消済み・未発行・存在しないProject）はすべてFORBIDDEN。 */
  async requireRole(principal: Principal, projectId: string, role: ProjectRole): Promise<string> {
    if (principal === null) throw new UnauthenticatedError();
    if (!(await this.projectGrantRepository.hasRole(projectId, principal, role))) {
      throw new ForbiddenError(`Principal does not have the ${role} role in this Project`, {
        requiredRole: role,
        projectId,
      });
    }
    return principal;
  }

  /** いずれかのRole Grantを要求する（remote modeのDirection参照tool）。Grant無しはFORBIDDEN。 */
  async requireAnyRole(principal: Principal, projectId: string): Promise<string> {
    if (principal === null) throw new UnauthenticatedError();
    if (!(await this.projectGrantRepository.hasAnyRole(projectId, principal))) {
      throw new ForbiddenError("Principal does not have any Role Grant in this Project", { projectId });
    }
    return principal;
  }

  /** いずれかのRole Grantを持つProjectのID（remote modeの`list_projects`）。 */
  async listGrantedProjectIds(principal: Principal): Promise<string[]> {
    if (principal === null) throw new UnauthenticatedError();
    return this.projectGrantRepository.listProjectIds(principal);
  }

  /**
   * 職務分離の誤用防止。そのRoleのGrantを持つPrincipalだけを拒否し、Principalなし・Grantなしは通す（管理面との互換）。
   * Agent名を変えれば回避できるため、trusted-localでは構造上の保証（Role用toolに該当操作が無いこと）が本体になる。
   */
  async requireNotRole(principal: Principal, projectId: string, role: ProjectRole): Promise<void> {
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
