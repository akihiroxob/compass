import type { HumanActor, WorkspaceMembership } from "../domain/HumanAuth.ts";
import type { WorkspaceMemberView, WorkspaceMembershipRepository } from "../domain/WorkspaceMembershipRepository.ts";
import { parseChangeMemberRoleInput } from "./humanAuthSchema.ts";
import { NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";
import { LastWorkspaceOwnerError } from "./error/LastOwnerError.ts";
import type { HumanWorkspaceAuthorizationService } from "./HumanWorkspaceAuthorizationService.ts";

/** Workspace memberの一覧。viewer以上。 */
export class ListWorkspaceMembersUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly membershipRepository: WorkspaceMembershipRepository,
  ) {}

  async execute(actor: HumanActor, workspaceId: string): Promise<WorkspaceMemberView[]> {
    await this.authorization.authorize(actor, workspaceId, "member.read");
    return this.membershipRepository.listActiveMembers(workspaceId);
  }
}

/**
 * Role変更はownerだけ。配下の全Projectへの次の操作から新しいRoleで認可する。ownerの自己降格は他に有効なownerがいる場合だけ。
 * 別Workspace・取消済みはNOT_FOUND。
 */
export class ChangeWorkspaceMemberRoleUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly membershipRepository: WorkspaceMembershipRepository,
  ) {}

  async execute(actor: HumanActor, workspaceId: string, membershipId: string, input: unknown): Promise<WorkspaceMembership> {
    await this.authorization.authorize(actor, workspaceId, "member.manage");
    const { role } = parseChangeMemberRoleInput(input);
    const result = await this.membershipRepository.changeRole(workspaceId, membershipId, role);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_found") throw new NotFoundError(`Membership ${membershipId} was not found`);
    if (result.kind === "last_owner") throw new LastWorkspaceOwnerError(workspaceId);
    return result.membership;
  }
}

/** Membership取消（除外）はownerだけ。配下の全Projectも次の操作から利用できない。行は削除せず`revokedAt`を記録する。最後のownerは取消せない。 */
export class RevokeWorkspaceMemberUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly membershipRepository: WorkspaceMembershipRepository,
  ) {}

  async execute(actor: HumanActor, workspaceId: string, membershipId: string): Promise<WorkspaceMembership> {
    await this.authorization.authorize(actor, workspaceId, "member.manage");
    const result = await this.membershipRepository.revoke(workspaceId, membershipId, actor.humanUserId);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_found") throw new NotFoundError(`Membership ${membershipId} was not found`);
    if (result.kind === "last_owner") throw new LastWorkspaceOwnerError(workspaceId);
    return result.membership;
  }
}
