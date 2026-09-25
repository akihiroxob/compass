export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: ApiIssue[] = [],
    /** 409 CONFLICTで、既にActiveなIntentがある場合のID。 */
    readonly activeIntentId: string | null = null,
    /** 409 CONFLICTで、Projectがarchivedのために拒否された場合は`archived`。Intent / Outcomeの状態とは別の項目。 */
    readonly projectStatus: string | null = null,
    /** 409 CONFLICTの種類（例 `LAST_OWNER`・`INVITATION_PENDING`）。 */
    readonly conflict: string | null = null,
  ) {
    super(message);
  }
}

type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readIssues = (value: unknown): ApiIssue[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        isRecord(item) && typeof item.message === "string"
          ? [{ path: typeof item.path === "string" ? item.path : "", message: item.message }]
          : [],
      )
    : [];

export const toApiError = (status: number, body: unknown): ApiError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  return new ApiError(
    status,
    typeof error.code === "string" ? error.code : "HTTP_ERROR",
    typeof error.message === "string" ? error.message : `Request failed (${status})`,
    readIssues(error.issues),
    typeof error.activeIntentId === "string" ? error.activeIntentId : null,
    typeof error.projectStatus === "string" ? error.projectStatus : null,
    typeof error.conflict === "string" ? error.conflict : null,
  );
};

// ---- Human Session（docs/step-6-human-auth-design.md）。CSRF tokenは`GET /api/auth/session`で得て、非安全methodへ付ける。 ----
let csrfToken: string | null = null;
let sessionLostListener: (() => void) | null = null;

export const setCsrfToken = (token: string | null) => {
  csrfToken = token;
};

/** Session切れ（401）・CSRF不一致（403 CSRF_REJECTED）を受けたときの通知先。画面は入力を残したまま再ログインを促す。 */
export const onSessionLost = (listener: (() => void) | null) => {
  sessionLostListener = listener;
};

const safeMethods = ["GET", "HEAD", "OPTIONS"];

/** 非安全methodだけ`X-Compass-CSRF`を付ける。CSRF tokenが無ければ変更しない（serverが401 / 403で拒否する）。 */
export const withCsrf = (init: RequestInit | undefined, token: string | null = csrfToken): RequestInit | undefined => {
  if (token === null || safeMethods.includes((init?.method ?? "GET").toUpperCase())) return init;
  const headers = new Headers(init?.headers);
  headers.set("X-Compass-CSRF", token);
  return { ...init, headers };
};

export const request = async <T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetchImpl(path, withCsrf(init));
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "サーバーに接続できませんでした");
  }
  const body = await readJson(response);
  if (!response.ok) {
    const error = toApiError(response.status, body);
    if (isSessionLost(error)) sessionLostListener?.();
    throw error;
  }
  if (body === null) throw new ApiError(response.status, "INVALID_RESPONSE", "応答を解釈できませんでした");
  return body as T;
};

const topLevelLabels: Record<string, string> = {
  name: "Project名",
  description: "説明",
  mission: "Mission",
  vision: "Vision",
  principles: "Principles",
  constraints: "Constraints",
  repositories: "Repositories",
  resources: "Resources",
  title: "タイトル",
  desiredState: "実現したい状態",
  completionDefinition: "完了の定義",
  reason: "放棄の理由",
  hypothesis: "仮説",
  rationale: "判断理由",
  successCriteria: "成功条件",
  principalId: "Agent名",
  role: "Role",
};
const linkFieldLabels: Record<string, string> = {
  name: "名前",
  url: "URL",
  kind: "種類",
  description: "内容",
  measurement: "測定方法",
  target: "目標値",
};

/** サーバーのissue path（例 `repositories.0.url`）を、フォームのaria-labelと同じ表記へ変換する。 */
export const formatIssuePath = (path: string): string => {
  if (path === "") return "入力全体";
  const [head = "", second, third] = path.split(".");
  const label = topLevelLabels[head] ?? head;
  if (second === undefined) return label;
  const row = Number(second);
  if (!Number.isInteger(row)) return path;
  const rowLabel = `${label} ${row + 1}`;
  return third === undefined ? rowLabel : `${rowLabel}の${linkFieldLabels[third] ?? third}`;
};

/** フォーム入力のid。issue pathと同じ規則で作るため、issueから該当入力を引ける。 */
export const fieldId = (path: string): string => `field-${path.replaceAll(".", "-")}`;

export type FormIssue = { fieldId: string | null; label: string; message: string };

export type ErrorKind =
  | { kind: "validation"; issues: FormIssue[] }
  | { kind: "not_found" }
  | { kind: "project_archived"; message: string }
  | { kind: "conflict"; message: string; activeIntentId: string | null }
  | { kind: "other"; message: string };

/** Sessionが無効（401）か、別タブの再ログイン等でCSRF tokenが古くなった（403 CSRF_REJECTED）。 */
export const isSessionLost = (error: ApiError) =>
  error.status === 401 || (error.status === 403 && error.code === "CSRF_REJECTED");

const conflictMessages: Record<string, string> = {
  LAST_OWNER: "Projectには少なくとも1人のownerが必要です。別のMemberをownerにしてから変更してください。",
  INVITATION_PENDING: "このメールアドレスには有効な招待が既にあります。取り消してから再発行してください。",
  INVITATION_NOT_PENDING: "受諾済み・取消済み・期限切れの招待は取り消せません。",
};

export const classifyError = (error: unknown): ErrorKind => {
  if (!(error instanceof ApiError)) {
    return { kind: "other", message: error instanceof Error ? error.message : "不明なエラー" };
  }
  if (error.status === 400 && error.code === "VALIDATION_ERROR") {
    const issues = error.issues.length ? error.issues : [{ path: "", message: error.message }];
    return {
      kind: "validation",
      issues: issues.map(({ path, message }) => ({
        fieldId: path === "" ? null : fieldId(path),
        label: formatIssuePath(path),
        message,
      })),
    };
  }
  if (error.status === 404 && error.code === "NOT_FOUND") return { kind: "not_found" };
  // Session切れ・権限不足はサーバーの英語文言を出さず、入力が残っていることと次の行動を示す。
  if (isSessionLost(error)) {
    return { kind: "other", message: "ログインの有効期限が切れたか、別の画面でログインし直しました。入力内容はこの画面に残っています。再ログイン後にもう一度実行してください。" };
  }
  if (error.status === 403 && error.code === "FORBIDDEN") {
    return { kind: "other", message: "この操作を行う権限がありません。ProjectのownerにRoleを確認してください。" };
  }
  // archivedによる拒否は、Intent / Outcomeの状態の競合と区別する（復帰はできないため、再試行を促さない）。
  if (error.status === 409 && error.code === "CONFLICT" && error.projectStatus === "archived") {
    return { kind: "project_archived", message: "アーカイブ済みのため変更できません。" };
  }
  if (error.status === 409 && error.code === "CONFLICT") {
    const message = (error.conflict && conflictMessages[error.conflict]) ?? error.message;
    return { kind: "conflict", message, activeIntentId: error.activeIntentId };
  }
  return { kind: "other", message: error.message };
};

export const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** bodyを省略した場合はJSON bodyなしのPOSTになる（放棄・取消以外の状態遷移用）。 */
export const jsonPost = (body?: unknown): RequestInit => (body === undefined ? { method: "POST" } : jsonInit("POST", body));

/** 読み込み失敗時に画面へ出す文言。not_foundだけは画面ごとの文言を渡す。 */
export const loadFailureMessage = (classified: ErrorKind, notFound: string): string =>
  classified.kind === "not_found" ? notFound : classified.kind === "validation" ? "入力内容が不正です" : classified.message;

/** フォーム送信の失敗表示用。not_foundは、入力を保持したまま再試行できる文言付きの`other`へ変換する。 */
export const withNotFoundMessage = (classified: ErrorKind, notFound: string): Exclude<ErrorKind, { kind: "not_found" }> =>
  classified.kind === "not_found" ? { kind: "other", message: notFound } : classified;

/** 確認パネルなど、1行で出す操作失敗の文言。 */
export const describeActionFailure = (classified: ErrorKind, notFound: string): string =>
  classified.kind === "validation"
    ? classified.issues.map((issue) => `${issue.label}: ${issue.message}`).join(" / ")
    : classified.kind === "not_found"
      ? notFound
      : classified.message;
