import type { WorkspaceRole } from "./RoleScope.ts";

/** Workspace Directionの権限。Project Grantへの継承はしない。 */
export type WorkspaceGrant = {
  workspaceId: string;
  principalId: string;
  role: WorkspaceRole;
  createdAt: number;
};
export type WorkspaceGrantResult = { grant: WorkspaceGrant; created: boolean };
export interface WorkspaceGrantRepository {
  /**
   * archive検査は書込と同じtransactionで行う。再付与はcreatedAtを変えない。PrincipalがこのWorkspace以外のscopeの
   * 有効なAgent Credentialに束縛されていれば`principal_bound_elsewhere`で何も書かない。
   */
  grant(workspaceId: string, principalId: string, role: WorkspaceRole): Promise<
    | ({ kind: "granted" } & WorkspaceGrantResult)
    | { kind: "principal_bound_elsewhere" }
    | { kind: "workspace_archived" }
  >;
  /** 取消は冪等で、他のWorkspace・Role・PrincipalのGrantには影響しない。 */
  revoke(workspaceId: string, principalId: string, role: WorkspaceRole): Promise<
    | { kind: "revoked"; revoked: boolean }
    | { kind: "workspace_archived" }
  >;
  hasRole(workspaceId: string, principalId: string, role: WorkspaceRole): Promise<boolean>;
  listWorkspaceIds(principalId: string, role?: WorkspaceRole): Promise<string[]>;
  listByWorkspace(workspaceId: string): Promise<WorkspaceGrant[]>;
}
