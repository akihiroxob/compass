import {
  hasMinimumRole,
  humanProjectPermissions,
  type HumanActor,
  type HumanProjectOperation,
  type HumanRole,
  type ProjectMembership,
} from "../../domain/model/HumanAuth.ts";
import type { ProjectMembershipRepository } from "../../domain/repository/ProjectMembershipRepository.ts";
import { ForbiddenError } from "../error/ForbiddenError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

/**
 * Human Membershipによる認可。Agent向けの`ProjectAuthorizationService`（Grant無しは403）とは別で、
 * 未所属・取消済み・存在しないProjectはすべて404にしてProject IDの存在を漏らさない。
 * 検査は毎回Repositoryを読むため、Role変更・取消は次の呼出しから反映される。
 */
export class HumanProjectAuthorizationService {
  constructor(private readonly membershipRepository: ProjectMembershipRepository) {}

  /** 操作に必要な最低Roleはdomainの権限表（`humanProjectPermissions`）から引く。 */
  authorize(actor: HumanActor, projectId: string, operation: HumanProjectOperation): Promise<ProjectMembership> {
    return this.requireProjectRole(actor, projectId, humanProjectPermissions[operation]);
  }

  async requireProjectRole(actor: HumanActor, projectId: string, minimumRole: HumanRole): Promise<ProjectMembership> {
    const membership = await this.membershipRepository.findActiveMembership(projectId, actor.humanUserId);
    if (!membership) throw new NotFoundError(`Project ${projectId} was not found`);
    if (!hasMinimumRole(membership.role, minimumRole)) {
      throw new ForbiddenError(`The ${minimumRole} role or higher is required in this Project`, {
        requiredRole: minimumRole,
        projectId,
      });
    }
    return membership;
  }
}
