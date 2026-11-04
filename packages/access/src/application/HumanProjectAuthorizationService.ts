import {
  hasMinimumRole,
  humanProjectPermissions,
  type HumanActor,
  type HumanProjectOperation,
  type HumanRole,
  type WorkspaceMembership,
} from "../domain/HumanAuth.ts";
import type { WorkspaceMembershipRepository } from "../domain/WorkspaceMembershipRepository.ts";
import type { ProjectStateReader } from "./port/ProjectStateReader.ts";
import type { WorkspaceStateReader } from "./port/WorkspaceStateReader.ts";
import { ForbiddenError, NotFoundError } from "@compass/shared";

/**
 * HumanのProject操作の認可（ADR 0003）。Serverが対象Projectの所属Workspaceを解決し、そのWorkspace Membershipの
 * Roleを操作別の最低Role（`humanProjectPermissions`）と比べる。Project単位のMembershipは持たない。
 * Agent向けの`ProjectAuthorizationService`（Grant無しは403）とは別で、未所属・取消済み・存在しないProjectはすべて404にして
 * Project IDの存在を漏らさない。検査は毎回Repositoryを読むため、WorkspaceでのRole変更・除外は次の呼出しから反映される。
 */
export class HumanProjectAuthorizationService {
  constructor(
    private readonly membershipRepository: WorkspaceMembershipRepository,
    private readonly projects: Pick<ProjectStateReader, "findWorkspaceId">,
    private readonly workspaces: Pick<WorkspaceStateReader, "listProjectIds">,
  ) {}

  /** 操作に必要な最低Roleはdomainの権限表（`humanProjectPermissions`）から引く。 */
  authorize(actor: HumanActor, projectId: string, operation: HumanProjectOperation): Promise<WorkspaceMembership> {
    return this.requireProjectRole(actor, projectId, humanProjectPermissions[operation]);
  }

  async requireProjectRole(actor: HumanActor, projectId: string, minimumRole: HumanRole): Promise<WorkspaceMembership> {
    const workspaceId = await this.projects.findWorkspaceId(projectId);
    const membership = workspaceId === null ? null : await this.membershipRepository.findActiveMembership(workspaceId, actor.humanUserId);
    if (!membership) throw new NotFoundError(`Project ${projectId} was not found`);
    if (!hasMinimumRole(membership.role, minimumRole)) {
      throw new ForbiddenError(`The ${minimumRole} role or higher is required in this Project's Workspace`, {
        requiredRole: minimumRole,
        projectId,
      });
    }
    return membership;
  }

  /** 有効なWorkspace Membershipを持つWorkspaceに所属するProjectのID（active / archivedを問わない）。横断一覧の絞り込みに使う。 */
  async listReadableProjectIds(actor: HumanActor): Promise<string[]> {
    const workspaceIds = await this.membershipRepository.listActiveWorkspaceIds(actor.humanUserId);
    return (await Promise.all(workspaceIds.map((workspaceId) => this.workspaces.listProjectIds(workspaceId)))).flat();
  }
}
