export type IntentStatus = "active" | "achieved" | "abandoned";

export type Intent = {
  id: string;
  workspaceId: string;
  title: string;
  desiredState: string;
  background: string | null;
  audience: string | null;
  constraints: string | null;
  completionDefinition: string | null;
  /** `YYYY-MM-DD`。 */
  targetDate: string | null;
  status: IntentStatus;
  abandonedReason: string | null;
  /** 保存のたびに進む版。編集は、画面を開いた時点の版を`expectedVersion`にして保存する。 */
  version: number;
  /** 実現したい状態・達成条件が最後に変わった版。 */
  meaningVersion: number;
  createdAt: number;
  updatedAt: number;
};

/** 版ごとの内容・変更主体・理由（追記専用）。 */
export type IntentRevision = {
  intentId: string;
  version: number;
  title: string;
  desiredState: string;
  completionDefinition: string | null;
  meaningChanged: boolean;
  reason: string | null;
  changedBy: string;
  changedByRole: string;
  createdAt: number;
};

/** フォームの項目。保存時はそのまま送り、空欄の任意項目はserverが未設定（null）として保存する。 */
export const intentFormFields = ["title", "desiredState", "background", "audience", "constraints", "completionDefinition", "targetDate"] as const;
export type IntentFormField = (typeof intentFormFields)[number];
export type IntentFormValues = Record<IntentFormField, string>;

export const emptyIntentFormValues: IntentFormValues = {
  title: "",
  desiredState: "",
  background: "",
  audience: "",
  constraints: "",
  completionDefinition: "",
  targetDate: "",
};

/** 保存済みIntentから編集フォームの初期値を作る。未設定（null）は空欄として表示する。 */
export const formValuesFromIntent = (intent: Intent): IntentFormValues =>
  Object.fromEntries(intentFormFields.map((field) => [field, intent[field] ?? ""])) as IntentFormValues;

/** 項目の表示名。フォーム・詳細・入力エラーで同じ名前を使う。 */
export const intentFieldLabels: Record<IntentFormField | "reason", string> = {
  reason: "変更理由",
  title: "目標名",
  desiredState: "実現したい状態",
  background: "背景",
  audience: "対象",
  constraints: "制約",
  completionDefinition: "達成条件",
  targetDate: "目標日",
};

export const intentStatusLabels: Record<IntentStatus, string> = {
  active: "Active",
  achieved: "Achieved",
  abandoned: "Abandoned",
};

/** Active・過去のIntentをそれぞれ新しい順のまま返す。 */
export const splitIntents = (intents: Intent[]): { active: Intent[]; past: Intent[] } => ({
  active: intents.filter((intent) => intent.status === "active"),
  past: intents.filter((intent) => intent.status !== "active"),
});
