// テストからも読み込むため、他moduleをimportしない純関数だけを置く。

export type ProjectOperationAccess = "allowed" | "archived" | "forbidden";

/**
 * Projectのstatusと、`myRole`が権限表で操作を許されるか（`canOperate`の結果）から、操作できるかを決める。
 * archivedではRoleにかかわらず変更できない。
 */
export const projectOperationAccess = (project: { status: "active" | "archived" }, roleAllows: boolean): ProjectOperationAccess =>
  project.status === "archived" ? "archived" : roleAllows ? "allowed" : "forbidden";

/** 作成・編集の画面をURLで直接開いたが操作できないときに、フォームの代わりに表示する文言。 */
export const projectOperationDeniedMessage = (access: Exclude<ProjectOperationAccess, "allowed">): string =>
  access === "archived"
    ? "アーカイブ済みのProjectは変更できません。内容と履歴は詳細画面で参照できます。"
    : "このProjectでこの操作を行う権限がありません。必要な場合はProjectのownerにRoleの変更を依頼してください。";
