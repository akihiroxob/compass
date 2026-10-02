/**
 * Project（Directionが所有）の状態の読取。Accessはprojectのtableを直接読まず、serverがDirectionの実装を渡す。
 * 書込と同じtransactionで検査する場合は、そのtransactionで読む実装を受け取る（`AccessProjectReaders`）。
 */
export interface ProjectStateReader {
  exists(projectId: string): Promise<boolean>;
  isArchived(projectId: string): Promise<boolean>;
  /** active / archivedを問わず、作成順のProject ID。 */
  listIdsInCreationOrder(): Promise<string[]>;
}
