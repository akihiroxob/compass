import type { ProjectOperationAccess } from "../access/model.ts";

export type OutcomeStatus = "active" | "evaluating" | "achieved" | "not_achieved" | "cancelled";

export type SuccessCriterion = {
  id: string;
  outcomeId: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
};

/** 課題の根拠の状態。serverの`problemEvidenceStatuses`と同じ値。 */
export const problemEvidenceStatuses = ["insufficient", "observed", "refuted"] as const;
export type ProblemEvidenceStatus = (typeof problemEvidenceStatuses)[number];

export const problemEvidenceStatusLabels: Record<ProblemEvidenceStatus, string> = {
  insufficient: "根拠不足",
  observed: "観測済み",
  refuted: "反証あり",
};

export type ProblemEvidenceKind = "research_finding" | "research_synthesis";

export const problemEvidenceKindLabels: Record<ProblemEvidenceKind, string> = {
  research_finding: "Researchの発見",
  research_synthesis: "Researchの結論",
};

/** 課題の根拠参照。`summary`・`requestId`・`superseded`はserverが参照先から解決した値。 */
export type ProblemEvidence = { kind: ProblemEvidenceKind; id: string; requestId: string; summary: string; superseded: boolean };

/** Outcomeの変化を妨げる課題。開発上の障害（Taskの停止等）は含まない。原因は常に仮説として扱う。 */
export type OutcomeProblem = {
  id: string;
  outcomeId: string;
  position: number;
  statement: string;
  evidenceStatus: ProblemEvidenceStatus;
  observation: string | null;
  causeHypothesis: string | null;
  solutionHypothesis: string | null;
  evidence: ProblemEvidence[];
};

export type Outcome = {
  id: string;
  workspaceId: string;
  intentId: string;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: OutcomeStatus;
  cancelReason: string | null;
  successCriteria: SuccessCriterion[];
  problems: OutcomeProblem[];
  /** 更新のたびに増える版。課題の保存時に`expectedRevision`として送る。 */
  revision: number;
  originDecisionId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CriterionFormValues = { description: string; measurement: string; target: string };

/** 根拠参照の入力。表示用の`summary`等は選択時・読込時の値を持ち、送信は`kind`・`id`だけ。 */
export type EvidenceFormValue = Omit<ProblemEvidence, "superseded"> & { superseded?: boolean };

export type ProblemFormValues = {
  /** 保存済みの課題のID。新しい課題は未指定。 */
  id?: string;
  statement: string;
  evidenceStatus: ProblemEvidenceStatus;
  observation: string;
  causeHypothesis: string;
  solutionHypothesis: string;
  evidence: EvidenceFormValue[];
};

export type OutcomeFormValues = {
  title: string;
  description: string;
  hypothesis: string;
  rationale: string;
  successCriteria: CriterionFormValues[];
  problems: ProblemFormValues[];
};

/** 課題・根拠参照の上限。サーバー側の入力規則（direction/outcomeSchema）と同じ値。 */
export const maxOutcomeProblems = 10;
export const maxProblemEvidence = 10;

export const emptyProblem: ProblemFormValues = { statement: "", evidenceStatus: "insufficient", observation: "", causeHypothesis: "", solutionHypothesis: "", evidence: [] };

/** 観測済み・反証は、観測内容と根拠参照が必須（serverと同じ規則）。 */
export const problemNeedsEvidence = (status: ProblemEvidenceStatus) => status !== "insufficient";

/** 送信する課題の入力。表示用の値を除き、空の任意項目はnullにする。 */
export const problemsInput = (problems: ProblemFormValues[]) =>
  problems.map((problem) => ({
    ...(problem.id ? { id: problem.id } : {}),
    statement: problem.statement,
    evidenceStatus: problem.evidenceStatus,
    observation: problem.observation || null,
    causeHypothesis: problem.causeHypothesis || null,
    solutionHypothesis: problem.solutionHypothesis || null,
    evidence: problem.evidence.map(({ kind, id }) => ({ kind, id })),
  }));

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
  problems: [],
};

/** 保存済みOutcomeから編集フォームの初期値を作る。編集できるのはtitle・hypothesis・課題で、他は表示専用。 */
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
  problems: outcome.problems.map((problem) => ({
    id: problem.id,
    statement: problem.statement,
    evidenceStatus: problem.evidenceStatus,
    observation: problem.observation ?? "",
    causeHypothesis: problem.causeHypothesis ?? "",
    solutionHypothesis: problem.solutionHypothesis ?? "",
    evidence: problem.evidence,
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

/**
 * IntentにActiveなOutcomeが無いときの案内。OutcomeはStrategistの判断で登録され、Humanの登録は登録できる場合だけ案内する。
 * Activeでない（達成・放棄した）Intentや、archivedのProjectには新しいOutcomeが登録されないため、担い手を示さない。
 * Intentの状態は文字列で受ける（intentがoutcomeを合成するため、outcomeはintentへ依存しない）。
 */
export const outcomeEmptyMessage = (intentStatus: string, access: ProjectOperationAccess | "loading" | "error", hasPast: boolean): string => {
  const head = hasPast ? "ActiveなOutcomeはありません。" : "Outcomeはまだありません。";
  if (intentStatus !== "active" || access === "archived") return hasPast ? head : "Outcomeはありません。";
  return access === "allowed"
    ? `${head}Strategistが判断して登録するとここに表示されます。Humanが判断した場合は「Outcomeを登録」から登録できます。`
    : `${head}Strategistが判断して登録するとここに表示されます。`;
};
