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

/** Organizationが所有するtable。Project・ProjectResourceはDirectionから段階的に移す（docs/workspace-migration-impact-map.md）。 */
export type OrganizationDatabase = {
  workspace: WorkspaceTable;
  workspace_principle: WorkspaceOrderedTextTable;
  workspace_constraint: WorkspaceOrderedTextTable;
};
