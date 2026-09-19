export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: ApiIssue[] = [],
    /** 409 CONFLICTで、既にActiveなIntentがある場合のID。 */
    readonly activeIntentId: string | null = null,
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
  );
};

export const request = async <T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "サーバーに接続できませんでした");
  }
  const body = await readJson(response);
  if (!response.ok) throw toApiError(response.status, body);
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
  | { kind: "conflict"; message: string; activeIntentId: string | null }
  | { kind: "other"; message: string };

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
  if (error.status === 409 && error.code === "CONFLICT") {
    return { kind: "conflict", message: error.message, activeIntentId: error.activeIntentId };
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
