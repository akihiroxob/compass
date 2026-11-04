import type { HumanRole, ProjectInvitation } from "./HumanAuth.ts";
import type { ProjectArchivedResult } from "./ProjectArchivedResult.ts";

/** archivedのProjectは参照専用。招待の書込を同一transactionで拒否する。 */

export type CreateInvitationCommand = {
  projectId: string;
  email: string;
  role: HumanRole;
  tokenHash: string;
  expiresAt: number;
  createdByHumanUserId: string;
};

export type CreateInvitationResult =
  | { kind: "created"; invitation: ProjectInvitation }
  /** 同じProject・emailの期限内の未使用（pending）招待が既にある（取消してから再発行する）。期限切れのpendingは再発行と同時に取消扱いにする。 */
  | { kind: "pending_exists" }
  | ProjectArchivedResult;

export type RevokeInvitationResult =
  | { kind: "revoked"; invitation: ProjectInvitation }
  | { kind: "not_found" }
  /** 受諾済み・取消済み・期限切れ。 */
  | { kind: "not_pending" }
  | ProjectArchivedResult;

/**
 * Projectから発行する招待。受諾すると、そのProjectの所属WorkspaceのMembershipを招待のRoleで付与する（ADR 0003）。
 * Project単位のMembershipは作らない。
 */
export interface ProjectInvitationRepository {
  createInvitation(command: CreateInvitationCommand): Promise<CreateInvitationResult>;
  /** 作成の新しい順。 */
  listInvitations(projectId: string): Promise<ProjectInvitation[]>;
  /** pendingかつ期限内だけを取消す。別Projectの招待は`not_found`。 */
  revokeInvitation(projectId: string, invitationId: string, revokedByHumanUserId: string): Promise<RevokeInvitationResult>;
}
