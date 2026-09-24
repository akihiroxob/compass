import type { HumanRole, HumanUser, ProjectInvitation, ProjectMembership } from "../model/HumanAuth.ts";

export type MemberView = { membership: ProjectMembership; human: Pick<HumanUser, "id" | "displayName" | "email"> };

/** 最後のownerを失う変更。 */
export type LastOwnerResult = { kind: "last_owner" };
/** archivedのProjectは参照専用。Membership・招待の書込を同一transactionで拒否する。 */
export type ProjectArchivedResult = { kind: "project_archived" };

export type ChangeMemberRoleResult = { kind: "changed"; membership: ProjectMembership } | { kind: "not_found" } | LastOwnerResult | ProjectArchivedResult;
export type RevokeMemberResult =
  | { kind: "revoked"; membership: ProjectMembership }
  | { kind: "not_found" }
  | LastOwnerResult
  | ProjectArchivedResult;

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

export interface ProjectMembershipRepository {
  /** 有効なMembership（未取消）。無ければnull。 */
  findActiveMembership(projectId: string, humanUserId: string): Promise<ProjectMembership | null>;
  /** 有効なMembershipを持つProjectのID。 */
  listActiveProjectIds(humanUserId: string): Promise<string[]>;
  /** 有効なMembershipをRoleの強い順・作成順で返す。 */
  listActiveMembers(projectId: string): Promise<MemberView[]>;
  /** 有効なowner数が0になる変更は同一transactionで検査して`last_owner`を返す。別Project・取消済みは`not_found`。 */
  changeRole(projectId: string, membershipId: string, role: HumanRole): Promise<ChangeMemberRoleResult>;
  revoke(projectId: string, membershipId: string, revokedByHumanUserId: string): Promise<RevokeMemberResult>;
  createInvitation(command: CreateInvitationCommand): Promise<CreateInvitationResult>;
  /** 作成の新しい順。 */
  listInvitations(projectId: string): Promise<ProjectInvitation[]>;
  /** pendingかつ期限内だけを取消す。別Projectの招待は`not_found`。 */
  revokeInvitation(projectId: string, invitationId: string, revokedByHumanUserId: string): Promise<RevokeInvitationResult>;
}
