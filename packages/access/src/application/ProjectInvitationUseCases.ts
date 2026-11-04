import type { HumanActor, ProjectInvitation } from "../domain/HumanAuth.ts";
import type { ProjectInvitationRepository } from "../domain/ProjectInvitationRepository.ts";
import { parseCreateInvitationInput } from "./humanAuthSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { ProjectArchivedError } from "@compass/organization";
import type { HumanProjectAuthorizationService } from "./HumanProjectAuthorizationService.ts";
import { generateSecretToken, hashSecretToken } from "./secretToken.ts";

/**
 * 招待の発行は所属Workspaceのownerだけ。受諾するとWorkspaceのMembershipになり、配下の全Projectへ同じRoleを適用する。
 * tokenの平文は応答で一度だけ返し、DBにはhashだけを保存する。メールは送らない。
 */
export class CreateProjectInvitationUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly invitationRepository: ProjectInvitationRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(
    actor: HumanActor,
    projectId: string,
    input: unknown,
  ): Promise<{ invitation: ProjectInvitation; token: string }> {
    await this.authorization.authorize(actor, projectId, "invitation.manage");
    const { email, role, expiresInHours } = parseCreateInvitationInput(input);
    const token = generateSecretToken();
    const result = await this.invitationRepository.createInvitation({
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
    private readonly invitationRepository: ProjectInvitationRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string): Promise<ProjectInvitation[]> {
    await this.authorization.authorize(actor, projectId, "invitation.manage");
    return this.invitationRepository.listInvitations(projectId);
  }
}

/** 招待の取消はownerだけ。受諾済み・取消済み・期限切れはCONFLICT、別ProjectはNOT_FOUND。 */
export class RevokeProjectInvitationUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly invitationRepository: ProjectInvitationRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string, invitationId: string): Promise<ProjectInvitation> {
    await this.authorization.authorize(actor, projectId, "invitation.manage");
    const result = await this.invitationRepository.revokeInvitation(projectId, invitationId, actor.humanUserId);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "not_found") throw new NotFoundError(`Invitation ${invitationId} was not found`);
    if (result.kind === "not_pending") {
      throw new ConflictError("Only a pending, unexpired invitation can be revoked", { conflict: "INVITATION_NOT_PENDING" });
    }
    return result.invitation;
  }
}
