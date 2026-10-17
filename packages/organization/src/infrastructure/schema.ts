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

/** 戦略値（Mission等）は所属Workspaceが正本で、Projectはpurpose（`description`）・状態・Resourceだけを持つ。 */
export type ProjectTable = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  status: "active" | "archived";
  archived_at: number | null;
  archive_reason: string | null;
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
  project_repository_link: ProjectRepositoryLinkTable;
  project_resource: ProjectResourceTable;
};
