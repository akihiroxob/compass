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

/** Repository URLから表示名を導く。末尾のパス要素（`.git`除く）を使い、無ければホスト名にする。 */
export const repositoryNameFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url.trim());
    const last = parsed.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "");
    return (last || parsed.hostname).slice(0, 100);
  } catch {
    return url.trim().slice(0, 100);
  }
};

/** 保存時、Repositoryの表示名を各URLから導く（名前は入力させない）。空URLの行は名前を補わずserverのURL検証に任せるため、名前だけが原因の別エラーを出さない仮の値を置く。 */
export const withDerivedNames = (rows: LinkInput[]): LinkInput[] =>
  rows.map((row) => ({ ...row, name: row.url.trim() ? repositoryNameFromUrl(row.url) : "Repository", url: row.url.trim() }));
