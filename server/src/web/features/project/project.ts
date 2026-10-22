/** 作成・編集フォームが扱う1行分のリンク。`id`は保存済みの行だけが持ち、更新時に既存行を維持する。 */
export type LinkInput = { id?: string; name: string; url: string; kind: string };

/** Web API `GET /api/projects/:projectId`のProject。Mission等は所属Workspaceの値（参照専用）。 */
export type Project = {
  id: string;
  /** 所属Workspace。Mission等の戦略値とDirection（Intent・Outcome等）はWorkspaceが所有する。 */
  workspaceId: string;
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
  repositories: { id: string; name: string; url: string }[];
  resources: { id: string; name: string; url: string; kind: string | null }[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  archivedAt: number | null;
  archiveReason: string | null;
};

/** Projectの作成・編集フォームの値。Mission等は所属Workspaceが所有し、Workspaceの編集で扱う。 */
export type ProjectFormValues = {
  name: string;
  description: string;
  repositories: LinkInput[];
  resources: LinkInput[];
};

export const emptyFormValues: ProjectFormValues = {
  name: "",
  description: "",
  repositories: [],
  resources: [],
};

/** 保存済みProjectから編集フォームの初期値を作る。未設定（null）は空欄として表示する。 */
export const formValuesFromProject = (project: Project): ProjectFormValues => ({
  name: project.name,
  description: project.description ?? "",
  repositories: project.repositories.map(({ id, name, url }) => ({ id, name, url, kind: "" })),
  resources: project.resources.map(({ id, name, url, kind }) => ({ id, name, url, kind: kind ?? "" })),
});
