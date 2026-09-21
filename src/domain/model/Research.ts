export type ResearchRequestKind = "project_watch" | "decision";

export type ResearchRequestStatus =
  | "requested"
  | "running"
  | "completed"
  | "insufficient"
  | "not_needed"
  | "cancelled";

/** 終了した状態。到達後はResult / Synthesisの登録も状態変更も受け付けない。 */
export const closedResearchStatuses = ["completed", "insufficient", "not_needed", "cancelled"] as const;

export type ClosedResearchStatus = (typeof closedResearchStatuses)[number];

/** Researcherが確定できる終了状態。`cancelled`は取消操作でだけ到達する。 */
export const researchConclusions = ["completed", "insufficient", "not_needed"] as const;

export type ResearchConclusion = (typeof researchConclusions)[number];

export const isClosedResearchStatus = (status: ResearchRequestStatus): status is ClosedResearchStatus =>
  (closedResearchStatuses as readonly string[]).includes(status);

export const researchConfidences = ["low", "medium", "high"] as const;

export type ResearchConfidence = (typeof researchConfidences)[number];

export const evidenceKinds = ["url", "repository_file", "issue", "pull_request", "ci", "wacha_run"] as const;

export type EvidenceKind = (typeof evidenceKinds)[number];

/** 予算の単位はRuntimeが定める。Compassは総量と使用量の整合だけを保証する。 */
export type ResearchRequest = {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ResearchRequestKind;
  readonly originIntentId: string | null;
  readonly originOutcomeId: string | null;
  readonly question: string;
  readonly scope: string;
  readonly completionCondition: string;
  readonly budgetTotal: number;
  readonly budgetUsed: number;
  readonly deadlineAt: number | null;
  readonly status: ResearchRequestStatus;
  /** insufficient / not_needed / cancelled の理由。completed / 未終了はnull。 */
  readonly stopReason: string | null;
  readonly correlationId: string;
  readonly requestKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type EvidenceReference = {
  readonly id: string;
  readonly projectId: string;
  readonly resultId: string;
  readonly position: number;
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly retrievedAt: number;
  readonly versionHash: string | null;
};

/** 原子的な発見。作成後は変更しない。Evidenceは同じResultの参照から選ぶ。 */
export type ResearchFinding = {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly resultId: string;
  readonly position: number;
  readonly statement: string;
  readonly confidence: ResearchConfidence;
  readonly observedAt: number;
  readonly expiresAt: number | null;
  readonly evidenceRefIds: readonly string[];
  /** このFindingが競合すると宣言した既存FindingのID。平均化・除外せず、そのまま残す。 */
  readonly conflictsWithFindingIds: readonly string[];
  readonly principalId: string;
  readonly runRef: string;
  readonly createdAt: number;
};

export type ResearchResult = {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  /** Request内の登録順（1始まり）。 */
  readonly sequence: number;
  readonly summary: string;
  readonly unknowns: readonly string[];
  readonly options: readonly string[];
  readonly risks: readonly string[];
  readonly budgetUsed: number;
  readonly evidenceRefs: readonly EvidenceReference[];
  readonly findings: readonly ResearchFinding[];
  readonly principalId: string;
  readonly runRef: string;
  readonly createdAt: number;
};

/** 上書きせず、`supersedesId`で前versionを指す新しい行として追加する。 */
export type ResearchSynthesis = {
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly version: number;
  readonly supersedesId: string | null;
  readonly conclusion: string;
  readonly findingIds: readonly string[];
  readonly risks: readonly string[];
  readonly options: readonly string[];
  readonly unknowns: readonly string[];
  readonly validAsOf: number;
  readonly principalId: string;
  readonly runRef: string;
  readonly createdAt: number;
};

/** Requestと、Project・発端Intentから辿れる来歴（Result → Finding / Evidence、Synthesis）をまとめた読取モデル。 */
export type ResearchRequestDetail = {
  readonly request: ResearchRequest;
  readonly results: readonly ResearchResult[];
  readonly syntheses: readonly ResearchSynthesis[];
};
