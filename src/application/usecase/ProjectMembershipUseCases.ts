import type { HumanActor, ProjectInvitation, ProjectMembership } from "../../domain/model/HumanAuth.ts";
import type { MemberView, ProjectMembershipRepository } from "../../domain/repository/ProjectMembershipRepository.ts";
import { parseChangeMemberRoleInput, parseCreateInvitationInput } from "../../shared/humanAuthSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { LastOwnerError } from "../error/LastOwnerError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";
import type { HumanProjectAuthorizationService } from "../service/HumanProjectAuthorizationService.ts";
import { generateSecretToken, hashSecretToken } from "../service/secretToken.ts";

/** Membership一覧。同じProjectの協力者として他Memberのemailを含む。viewer以上。 */
export class ListProjectMembersUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly membershipRepository: ProjectMembershipRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string): Promise<MemberView[]> {
    await this.authorization.requireProjectRole(actor, projectId, "viewer");
    return this.membershipRepository.listActiveMembers(projectId);
  }
}

/**
 * Role変更はownerだけ（administrator以下の自己昇格を防ぐ）。ownerの自己降格は他に有効なownerがいる場合だけ。
 * 別Project・取消済みのMembershipはNOT_FOUND。
 */
export class ChangeProjectMemberRoleUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly membershipRepository: ProjectMembershipRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string, membershipId: string, input: unknown): Promise<ProjectMembership> {
    await this.authorization.requireProjectRole(actor, projectId, "owner");
    const { role } = parseChangeMemberRoleInput(input);
    const result = await this.membershipRepository.changeRole(projectId, membershipId, role);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "not_found") throw new NotFoundError(`Membership ${membershipId} was not found`);
    if (result.kind === "last_owner") throw new LastOwnerError(projectId);
    return result.membership;
  }
}

/** Membership取消はownerだけ。行は削除せず`revokedAt`を記録する。最後のownerは取消せない。 */
export class RevokeProjectMemberUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly membershipRepository: ProjectMembershipRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string, membershipId: string): Promise<ProjectMembership> {
    await this.authorization.requireProjectRole(actor, projectId, "owner");
    const result = await this.membershipRepository.revoke(projectId, membershipId, actor.humanUserId);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "not_found") throw new NotFoundError(`Membership ${membershipId} was not found`);
    if (result.kind === "last_owner") throw new LastOwnerError(projectId);
    return result.membership;
  }
}

/** 招待の発行はownerだけ。tokenの平文は応答で一度だけ返し、DBにはhashだけを保存する。メールは送らない。 */
export class CreateProjectInvitationUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly membershipRepository: ProjectMembershipRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(
    actor: HumanActor,
    projectId: string,
    input: unknown,
  ): Promise<{ invitation: ProjectInvitation; token: string }> {
    await this.authorization.requireProjectRole(actor, projectId, "owner");
    const { email, role, expiresInHours } = parseCreateInvitationInput(input);
    const token = generateSecretToken();
    const result = await this.membershipRepository.createInvitation({
      projectId,
      email,
      role,
      tokenHash: hashSecretToken(token),
      expiresAt: this.clock() + expiresInHours * 60 * 60 * 1000,
      createdByHumanUserId: actor.humanUserId,
    });
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "pending_exists") {
      throw new ConflictError("A pending invitation for this email already exists", { conflict: "INVITATION_PENDING" });
    }
    return { invitation: result.invitation, token };
  }
}

/** 招待一覧はownerだけ（tokenは含まない）。 */
export class ListProjectInvitationsUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly membershipRepository: ProjectMembershipRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string): Promise<ProjectInvitation[]> {
    await this.authorization.requireProjectRole(actor, projectId, "owner");
    return this.membershipRepository.listInvitations(projectId);
  }
}

/** 招待の取消はownerだけ。受諾済み・取消済み・期限切れはCONFLICT、別ProjectはNOT_FOUND。 */
export class RevokeProjectInvitationUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly membershipRepository: ProjectMembershipRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string, invitationId: string): Promise<ProjectInvitation> {
    await this.authorization.requireProjectRole(actor, projectId, "owner");
    const result = await this.membershipRepository.revokeInvitation(projectId, invitationId, actor.humanUserId);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "not_found") throw new NotFoundError(`Invitation ${invitationId} was not found`);
    if (result.kind === "not_pending") {
      throw new ConflictError("Only a pending, unexpired invitation can be revoked", { conflict: "INVITATION_NOT_PENDING" });
    }
    return result.invitation;
  }
}
