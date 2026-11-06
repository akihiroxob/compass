import type { HumanRole, WorkspaceInvitation } from "./HumanAuth.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceMembershipRepository.ts";

/** archivedのWorkspaceは参照専用。招待の書込を同一transactionで拒否する。 */

export type CreateInvitationCommand = {
  workspaceId: string;
  email: string;
  role: HumanRole;
  tokenHash: string;
  expiresAt: number;
  createdByHumanUserId: string;
};

export type CreateInvitationResult =
  | { kind: "created"; invitation: WorkspaceInvitation }
  /** 同じWorkspace・emailの期限内の未使用（pending）招待が既にある（取消してから再発行する）。期限切れのpendingは再発行と同時に取消扱いにする。 */
  | { kind: "pending_exists" }
  | WorkspaceArchivedResult;

export type RevokeInvitationResult =
  | { kind: "revoked"; invitation: WorkspaceInvitation }
  | { kind: "not_found" }
  /** 受諾済み・取消済み・期限切れ。 */
  | { kind: "not_pending" }
  | WorkspaceArchivedResult;

/**
 * Workspaceから発行する招待。受諾するとWorkspaceのMembershipを招待のRoleで付与する（ADR 0003）。
 * Project単位のMembershipは作らない。
 */
export interface WorkspaceInvitationRepository {
  createInvitation(command: CreateInvitationCommand): Promise<CreateInvitationResult>;
  /** 作成の新しい順。 */
  listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]>;
  /** pendingかつ期限内だけを取消す。別Workspaceの招待は`not_found`。 */
  revokeInvitation(workspaceId: string, invitationId: string, revokedByHumanUserId: string): Promise<RevokeInvitationResult>;
}
