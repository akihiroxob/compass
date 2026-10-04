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

/** 判定結果と、その判定をどの`projectId`・`operation`について行ったか。 */
export type KeyedProjectOperationResult<T> = { projectId: string; operation: string; result: T };

/**
 * 保持している判定結果を、現在の`projectId`・`operation`について行ったものに限って返す。
 * 一致しない（同じ画面のままProject IDが変わった直後など）ときは`null`を返し、前のProjectの結果を使わない。
 */
export const currentProjectOperationResult = <T>(stored: KeyedProjectOperationResult<T> | null, projectId: string, operation: string): T | null =>
  stored !== null && stored.projectId === projectId && stored.operation === operation ? stored.result : null;

/**
 * 一覧が空で、登録の導線を出せないときに添える案内。登録できる・判定中・判定失敗は`null`（導線だけを出す、または何も出さない）。
 * 権限の無いHumanには、操作の代わりに依頼先を示す。
 */
export const registrationUnavailableNote = (access: ProjectOperationAccess | "loading" | "error", subject: string): string | null =>
  access === "archived"
    ? `アーカイブ済みのため、${subject}は登録できません。`
    : access === "forbidden"
      ? `${subject}の登録には編集の権限が必要です。必要な場合はProjectのownerにRoleの変更を依頼してください。`
      : null;
