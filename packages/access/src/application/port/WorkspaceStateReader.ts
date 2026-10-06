/**
 * Workspace（Organizationが所有）の状態の読取。AccessはOrganizationのtableを直接読まず、serverが実装を渡す。
 * 書込と同じtransactionで検査する場合は、そのtransactionで読む実装を受け取る（`AccessWorkspaceReaders`）。
 */
export interface WorkspaceStateReader {
  isArchived(workspaceId: string): Promise<boolean>;
  /** active / archivedを問わず、作成順のWorkspace ID。 */
  listIdsInCreationOrder(): Promise<string[]>;
  /** Workspaceに所属するProjectのID（active / archivedを問わない）。 */
  listProjectIds(workspaceId: string): Promise<string[]>;
}
