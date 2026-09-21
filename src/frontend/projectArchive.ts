// テストからも読み込むため、他moduleをimportしない純関数だけを置く。

export type ProjectStatus = "active" | "archived";

export const projectStatusLabels: Record<ProjectStatus, string> = {
  active: "Active",
  archived: "アーカイブ済み",
};

export const maxArchiveReasonLength = 2_000;

/** 一覧の切替。URLの`?status=`は`archived`だけを受け付け、それ以外（未指定を含む）はactiveとして扱う。 */
export const parseListStatus = (value: string | null): ProjectStatus => (value === "archived" ? "archived" : "active");

/** 一覧のWeb API path。activeは既定のためqueryを付けない。 */
export const projectsApiPath = (status: ProjectStatus): string => (status === "archived" ? "/api/projects?status=archived" : "/api/projects");

/** 一覧画面のpath（切替のリンク先）。 */
export const projectListPath = (status: ProjectStatus): string => (status === "archived" ? "/?status=archived" : "/");

export const archiveProjectPath = (projectId: string): string => `/api/projects/${projectId}/archive`;

/** archiveのrequest。本文は`{ reason }`のみ（statusなどserver管理の項目は送らない）。 */
export const archiveInit = (reason: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ reason }),
});

/** 送信前の入力検証。問題がなければnull。サーバーも同じ規則（trim後1〜2,000文字）で検証する。 */
export const validateArchiveReason = (reason: string): string | null => {
  const trimmed = reason.trim();
  if (trimmed === "") return "アーカイブの理由を入力してください。";
  if (trimmed.length > maxArchiveReasonLength) return `アーカイブの理由は${maxArchiveReasonLength}文字以内で入力してください。`;
  return null;
};

/** 一覧カード用の理由の要約。改行を空白へ畳み、長い場合は省略する。 */
export const summarizeReason = (reason: string | null, maximum = 80): string => {
  const flat = (reason ?? "").replace(/\s+/g, " ").trim();
  return flat.length > maximum ? `${flat.slice(0, maximum)}…` : flat;
};

/** `api.ts`の`ErrorKind`のうち、archive操作の失敗表示が読む部分。 */
type ArchiveFailure =
  | { kind: "validation"; issues: { message: string }[] }
  | { kind: "not_found" }
  | { kind: "project_archived" | "conflict" | "other"; message: string };

/** archive操作の失敗を、確認パネルへ出す1行へ整形する。入力エラー（400）とarchived（409）を区別する。 */
export const describeArchiveFailure = (classified: ArchiveFailure): string => {
  switch (classified.kind) {
    case "validation":
      return classified.issues.map((issue) => `アーカイブの理由: ${issue.message}`).join(" / ");
    case "project_archived":
      return classified.message;
    case "not_found":
      return "Projectが見つかりません。";
    default:
      return classified.message;
  }
};
