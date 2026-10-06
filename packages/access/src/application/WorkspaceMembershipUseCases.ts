import type { HumanActor, WorkspaceMembership } from "../domain/HumanAuth.ts";
import type { WorkspaceMemberView, WorkspaceMembershipRepository } from "../domain/WorkspaceMembershipRepository.ts";
import { parseAddWorkspaceMemberInput, parseChangeMemberRoleInput } from "./humanAuthSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
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
 * Workspace memberの追加はownerだけ。対象は同じWorkspaceに所属するProjectの有効なMemberに限り、それ以外は
 * Humanの有無を区別せずNOT_FOUNDにする（emailでの検索やHuman一覧を公開しない）。Projectの権限は変えない。
 */
export class AddWorkspaceMemberUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly membershipRepository: WorkspaceMembershipRepository,
  ) {}

  async execute(actor: HumanActor, workspaceId: string, input: unknown): Promise<WorkspaceMembership> {
    await this.authorization.authorize(actor, workspaceId, "member.manage");
    const { humanUserId, role } = parseAddWorkspaceMemberInput(input);
    const result = await this.membershipRepository.add({
      workspaceId,
      humanUserId,
      role,
      createdByHumanUserId: actor.humanUserId,
    });
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_project_member") {
      throw new NotFoundError(`Human ${humanUserId} was not found among the members of this Workspace's Projects`);
    }
    if (result.kind === "already_member") {
      throw new ConflictError("The Human is already a member of this Workspace", { conflict: "ALREADY_MEMBER" });
    }
    return result.membership;
  }
}

/** Role変更はownerだけ。ownerの自己降格は他に有効なownerがいる場合だけ。別Workspace・取消済みはNOT_FOUND。 */
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

/** Membership取消はownerだけ。行は削除せず`revokedAt`を記録する。最後のownerは取消せない。 */
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
