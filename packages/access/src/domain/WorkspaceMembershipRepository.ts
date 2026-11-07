import type { HumanRole, HumanUser, WorkspaceMembership } from "./HumanAuth.ts";

export type WorkspaceMemberView = {
  membership: WorkspaceMembership;
  human: Pick<HumanUser, "id" | "displayName" | "email">;
};

/** 最後のownerを失う変更。 */
export type LastOwnerResult = { kind: "last_owner" };

/** archivedのWorkspaceは参照専用。Membershipの書込を同一transactionで拒否する。 */
export type WorkspaceArchivedResult = { kind: "workspace_archived" };

export type ChangeWorkspaceMemberRoleResult =
  | { kind: "changed"; membership: WorkspaceMembership }
  | { kind: "not_found" }
  | LastOwnerResult
  | WorkspaceArchivedResult;

export type RevokeWorkspaceMemberResult =
  | { kind: "revoked"; membership: WorkspaceMembership }
  | { kind: "not_found" }
  | LastOwnerResult
  | WorkspaceArchivedResult;

/**
 * HumanのWorkspace Membership（ADR 0003）。配下のすべてのProjectのHuman操作も、このMembershipで認可する。
 * 参加は招待の受諾・Workspace作成で成立し、ここからは追加しない。
 */
export interface WorkspaceMembershipRepository {
  /** 有効なMembership（未取消）。無ければnull。 */
  findActiveMembership(workspaceId: string, humanUserId: string): Promise<WorkspaceMembership | null>;
  /** 有効なMembershipを持つWorkspaceのID。 */
  listActiveWorkspaceIds(humanUserId: string): Promise<string[]>;
  /** 有効なMembershipをRoleの強い順・作成順で返す。 */
  listActiveMembers(workspaceId: string): Promise<WorkspaceMemberView[]>;
  /** 有効なowner数が0になる変更は同一transactionで検査して`last_owner`を返す。別Workspace・取消済みは`not_found`。 */
  changeRole(workspaceId: string, membershipId: string, role: HumanRole): Promise<ChangeWorkspaceMemberRoleResult>;
  revoke(workspaceId: string, membershipId: string, revokedByHumanUserId: string): Promise<RevokeWorkspaceMemberResult>;
}
