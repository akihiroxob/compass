import type { HumanActor, WorkspaceInvitation } from "../domain/HumanAuth.ts";
import type { WorkspaceInvitationRepository } from "../domain/WorkspaceInvitationRepository.ts";
import { parseCreateInvitationInput } from "./humanAuthSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";
import type { HumanWorkspaceAuthorizationService } from "./HumanWorkspaceAuthorizationService.ts";
import { generateSecretToken, hashSecretToken } from "./secretToken.ts";

/**
 * 招待の発行はWorkspaceのownerだけ。受諾するとWorkspaceのMembershipになり、配下の全Projectへ同じRoleを適用する。
 * tokenの平文は応答で一度だけ返し、DBにはhashだけを保存する。メールは送らない。
 */
export class CreateWorkspaceInvitationUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly invitationRepository: WorkspaceInvitationRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(
    actor: HumanActor,
    workspaceId: string,
    input: unknown,
  ): Promise<{ invitation: WorkspaceInvitation; token: string }> {
    await this.authorization.authorize(actor, workspaceId, "invitation.manage");
    const { email, role, expiresInHours } = parseCreateInvitationInput(input);
    const token = generateSecretToken();
    const result = await this.invitationRepository.createInvitation({
      workspaceId,
      email,
      role,
      tokenHash: hashSecretToken(token),
      expiresAt: this.clock() + expiresInHours * 60 * 60 * 1000,
      createdByHumanUserId: actor.humanUserId,
    });
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "pending_exists") {
      throw new ConflictError("A pending invitation for this email already exists", { conflict: "INVITATION_PENDING" });
    }
    return { invitation: result.invitation, token };
  }
}

/** 招待一覧はownerだけ（tokenは含まない）。 */
export class ListWorkspaceInvitationsUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly invitationRepository: WorkspaceInvitationRepository,
  ) {}

  async execute(actor: HumanActor, workspaceId: string): Promise<WorkspaceInvitation[]> {
    await this.authorization.authorize(actor, workspaceId, "invitation.manage");
    return this.invitationRepository.listInvitations(workspaceId);
  }
}

/** 招待の取消はownerだけ。受諾済み・取消済み・期限切れはCONFLICT、別WorkspaceはNOT_FOUND。 */
export class RevokeWorkspaceInvitationUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly invitationRepository: WorkspaceInvitationRepository,
  ) {}

  async execute(actor: HumanActor, workspaceId: string, invitationId: string): Promise<WorkspaceInvitation> {
    await this.authorization.authorize(actor, workspaceId, "invitation.manage");
    const result = await this.invitationRepository.revokeInvitation(workspaceId, invitationId, actor.humanUserId);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_found") throw new NotFoundError(`Invitation ${invitationId} was not found`);
    if (result.kind === "not_pending") {
      throw new ConflictError("Only a pending, unexpired invitation can be revoked", { conflict: "INVITATION_NOT_PENDING" });
    }
    return result.invitation;
  }
}
