export type OutcomeStatus = "active" | "evaluating" | "achieved" | "not_achieved" | "cancelled";

export type SuccessCriterion = {
  id: string;
  outcomeId: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
};

export type Outcome = {
  id: string;
  projectId: string;
  intentId: string;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: OutcomeStatus;
  cancelReason: string | null;
  successCriteria: SuccessCriterion[];
  createdAt: number;
  updatedAt: number;
};

export type CriterionFormValues = { description: string; measurement: string; target: string };

export type OutcomeFormValues = {
  title: string;
  description: string;
  hypothesis: string;
  rationale: string;
  successCriteria: CriterionFormValues[];
};

/** 成功条件の上限。サーバー側の入力規則（shared/outcomeSchema）と同じ値。 */
export const maxSuccessCriteria = 10;

export const emptyCriterion: CriterionFormValues = { description: "", measurement: "", target: "" };

/** 成功条件は1件以上が必須のため、最初から空の1行を持たせる。 */
export const emptyOutcomeFormValues: OutcomeFormValues = {
  title: "",
  description: "",
  hypothesis: "",
  rationale: "",
  successCriteria: [emptyCriterion],
};

/** 保存済みOutcomeから編集フォームの初期値を作る。編集できるのはtitleとhypothesisだけで、他は表示専用。 */
export const formValuesFromOutcome = (outcome: Outcome): OutcomeFormValues => ({
  title: outcome.title,
  description: outcome.description,
  hypothesis: outcome.hypothesis ?? "",
  rationale: outcome.rationale,
  successCriteria: outcome.successCriteria.map((item) => ({
    description: item.description,
    measurement: item.measurement,
    target: item.target ?? "",
  })),
});

export const outcomeStatusLabels: Record<OutcomeStatus, string> = {
  active: "Active",
  evaluating: "Evaluating",
  achieved: "Achieved",
  not_achieved: "Not achieved",
  cancelled: "Cancelled",
};

/** activeなOutcomeと、それ以外（取消済みなど）を、受け取った順（新しい順）のまま分ける。 */
export const splitOutcomes = (outcomes: Outcome[]): { active: Outcome[]; past: Outcome[] } => ({
  active: outcomes.filter((outcome) => outcome.status === "active"),
  past: outcomes.filter((outcome) => outcome.status !== "active"),
});
