/** 作成・編集フォームが扱う1行分のリンク。`id`は保存済みの行だけが持ち、更新時に既存行を維持する。 */
export type LinkInput = { id?: string; name: string; url: string; kind: string };

export type Project = {
  id: string;
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
};

export type ProjectFormValues = {
  name: string;
  description: string;
  mission: string;
  vision: string;
  principles: string[];
  constraints: string[];
  repositories: LinkInput[];
  resources: LinkInput[];
};

export const emptyFormValues: ProjectFormValues = {
  name: "",
  description: "",
  mission: "",
  vision: "",
  principles: [],
  constraints: [],
  repositories: [],
  resources: [],
};

/** 保存済みProjectから編集フォームの初期値を作る。未設定（null）は空欄として表示する。 */
export const formValuesFromProject = (project: Project): ProjectFormValues => ({
  name: project.name,
  description: project.description ?? "",
  mission: project.mission,
  vision: project.vision ?? "",
  principles: [...project.principles],
  constraints: [...project.constraints],
  repositories: project.repositories.map(({ id, name, url }) => ({ id, name, url, kind: "" })),
  resources: project.resources.map(({ id, name, url, kind }) => ({ id, name, url, kind: kind ?? "" })),
});
