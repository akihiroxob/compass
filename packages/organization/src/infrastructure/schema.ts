export type WorkspaceTable = {
  id: string;
  name: string;
  mission: string;
  vision: string | null;
  created_at: number;
  updated_at: number;
  status: "active" | "archived";
  archived_at: number | null;
  archive_reason: string | null;
};

type WorkspaceOrderedTextTable = {
  id: string;
  workspace_id: string;
  value: string;
  sort_order: number;
};

/**
 * `mission` / `vision`と`project_principle` / `project_constraint`は、戦略値の正本をWorkspaceへ移す前の列・table。
 * 読み書きしない（`mission`はNOT NULLのため作成時に空文字を書く）。削除は旧列の整理（S12-01）で行う。
 */
export type ProjectTable = {
  id: string;
  /** 所属Workspace。既存DBへnullableで追加した列のため型もnullableだが、起動時の移行と作成で全Projectに設定する。 */
  workspace_id: string | null;
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  created_at: number;
  updated_at: number;
  status: "active" | "archived";
  archived_at: number | null;
  archive_reason: string | null;
  /** 旧列の戦略値をWorkspaceへ写した時刻。nullは未移行（`migrateProjectStrategyToWorkspaces`の対象）。 */
  strategy_migrated_at: number | null;
};

type ProjectOrderedTextTable = {
  id: string;
  project_id: string;
  value: string;
  sort_order: number;
};

export type ProjectRepositoryLinkTable = {
  id: string;
  project_id: string;
  name: string;
  url: string;
  sort_order: number;
};

export type ProjectResourceTable = ProjectRepositoryLinkTable & {
  kind: string | null;
};

/** Organizationが所有するtable（Workspace・Project・ProjectのRepository / Resource）。 */
export type OrganizationDatabase = {
  workspace: WorkspaceTable;
  workspace_principle: WorkspaceOrderedTextTable;
  workspace_constraint: WorkspaceOrderedTextTable;
  project: ProjectTable;
  project_principle: ProjectOrderedTextTable;
  project_constraint: ProjectOrderedTextTable;
  project_repository_link: ProjectRepositoryLinkTable;
  project_resource: ProjectResourceTable;
};
