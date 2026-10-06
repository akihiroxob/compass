import {
  hasMinimumRole,
  humanWorkspacePermissions,
  type HumanActor,
  type HumanRole,
  type HumanWorkspaceOperation,
  type WorkspaceMembership,
} from "../domain/HumanAuth.ts";
import type { WorkspaceMembershipRepository } from "../domain/WorkspaceMembershipRepository.ts";
import { ForbiddenError, NotFoundError } from "@compass/shared";

/**
 * Human Workspace Membershipによる認可。`HumanProjectAuthorizationService`と同じく、未所属・取消済み・存在しない
 * Workspaceはすべて404にしてWorkspace IDの存在を漏らさない。Project Membershipからの継承はしない。
 */
export class HumanWorkspaceAuthorizationService {
  constructor(private readonly membershipRepository: WorkspaceMembershipRepository) {}

  /** 操作に必要な最低Roleはdomainの権限表（`humanWorkspacePermissions`）から引く。 */
  authorize(actor: HumanActor, workspaceId: string, operation: HumanWorkspaceOperation): Promise<WorkspaceMembership> {
    return this.requireWorkspaceRole(actor, workspaceId, humanWorkspacePermissions[operation]);
  }

  async requireWorkspaceRole(actor: HumanActor, workspaceId: string, minimumRole: HumanRole): Promise<WorkspaceMembership> {
    const membership = await this.membershipRepository.findActiveMembership(workspaceId, actor.humanUserId);
    if (!membership) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    if (!hasMinimumRole(membership.role, minimumRole)) {
      throw new ForbiddenError(`The ${minimumRole} role or higher is required in this Workspace`, {
        requiredRole: minimumRole,
        workspaceId,
      });
    }
    return membership;
  }
}
