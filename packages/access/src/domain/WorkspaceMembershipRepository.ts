import type { HumanRole, HumanUser, WorkspaceMembership } from "./HumanAuth.ts";
import type { LastOwnerResult } from "./ProjectMembershipRepository.ts";

export type WorkspaceMemberView = {
  membership: WorkspaceMembership;
  human: Pick<HumanUser, "id" | "displayName" | "email">;
};

/** archivedのWorkspaceは参照専用。Membershipの書込を同一transactionで拒否する。 */
export type WorkspaceArchivedResult = { kind: "workspace_archived" };

export type AddWorkspaceMemberCommand = {
  workspaceId: string;
  humanUserId: string;
  role: HumanRole;
  createdByHumanUserId: string;
};

export type AddWorkspaceMemberResult =
  | { kind: "added"; membership: WorkspaceMembership }
  /** 追加できるのは、そのWorkspaceに所属するProjectの有効なMemberだけ。それ以外のHumanの有無は区別しない。 */
  | { kind: "not_project_member" }
  | { kind: "already_member" }
  | WorkspaceArchivedResult;

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

export interface WorkspaceMembershipRepository {
  /** 有効なMembership（未取消）。無ければnull。 */
  findActiveMembership(workspaceId: string, humanUserId: string): Promise<WorkspaceMembership | null>;
  /** 有効なMembershipを持つWorkspaceのID。 */
  listActiveWorkspaceIds(humanUserId: string): Promise<string[]>;
  /** 有効なMembershipをRoleの強い順・作成順で返す。 */
  listActiveMembers(workspaceId: string): Promise<WorkspaceMemberView[]>;
  /** Projectの有効なMemberであることの検査と追加を同一transactionで行う。 */
  add(command: AddWorkspaceMemberCommand): Promise<AddWorkspaceMemberResult>;
  /** 有効なowner数が0になる変更は同一transactionで検査して`last_owner`を返す。別Workspace・取消済みは`not_found`。 */
  changeRole(workspaceId: string, membershipId: string, role: HumanRole): Promise<ChangeWorkspaceMemberRoleResult>;
  revoke(workspaceId: string, membershipId: string, revokedByHumanUserId: string): Promise<RevokeWorkspaceMemberResult>;
}
