export type IntentStatus = "active" | "achieved" | "abandoned";

export type Intent = {
  id: string;
  projectId: string;
  title: string;
  desiredState: string;
  completionDefinition: string | null;
  status: IntentStatus;
  abandonedReason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type IntentFormValues = {
  title: string;
  desiredState: string;
  completionDefinition: string;
};

export const emptyIntentFormValues: IntentFormValues = {
  title: "",
  desiredState: "",
  completionDefinition: "",
};

/** 保存済みIntentから編集フォームの初期値を作る。未設定（null）は空欄として表示する。 */
export const formValuesFromIntent = (intent: Intent): IntentFormValues => ({
  title: intent.title,
  desiredState: intent.desiredState,
  completionDefinition: intent.completionDefinition ?? "",
});

export const intentStatusLabels: Record<IntentStatus, string> = {
  active: "Active",
  achieved: "Achieved",
  abandoned: "Abandoned",
};

/** Projectにつきactiveは最大1件。それ以外（過去のIntent）は新しい順のまま返す。 */
export const splitIntents = (intents: Intent[]): { active: Intent | null; past: Intent[] } => ({
  active: intents.find((intent) => intent.status === "active") ?? null,
  past: intents.filter((intent) => intent.status !== "active"),
});
