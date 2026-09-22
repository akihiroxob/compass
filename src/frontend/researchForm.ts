export type ResearchRequestKind = "project_watch" | "decision";

export type ResearchRequestStatus =
  | "requested"
  | "running"
  | "completed"
  | "insufficient"
  | "not_needed"
  | "cancelled";

export type ResearchRequest = {
  id: string;
  projectId: string;
  kind: ResearchRequestKind;
  originIntentId: string | null;
  originOutcomeId: string | null;
  question: string;
  scope: string;
  completionCondition: string;
  budgetTotal: number;
  budgetUsed: number;
  deadlineAt: number | null;
  status: ResearchRequestStatus;
  stopReason: string | null;
  correlationId: string;
  createdAt: number;
  updatedAt: number;
};

export type EvidenceReference = {
  id: string;
  kind: string;
  uri: string;
  retrievedAt: number;
  versionHash: string | null;
};

export type ResearchFinding = {
  id: string;
  statement: string;
  confidence: "low" | "medium" | "high";
  observedAt: number;
  expiresAt: number | null;
  evidenceRefIds: string[];
  conflictsWithFindingIds: string[];
  principalId: string;
  runRef: string;
  createdAt: number;
};

export type ResearchResult = {
  id: string;
  sequence: number;
  summary: string;
  unknowns: string[];
  options: string[];
  risks: string[];
  budgetUsed: number;
  evidenceRefs: EvidenceReference[];
  findings: ResearchFinding[];
  principalId: string;
  runRef: string;
  createdAt: number;
};

export type ResearchSynthesis = {
  id: string;
  requestId: string;
  version: number;
  supersedesId: string | null;
  conclusion: string;
  findingIds: string[];
  risks: string[];
  options: string[];
  unknowns: string[];
  validAsOf: number;
  principalId: string;
  runRef: string;
  createdAt: number;
};

export type ResearchRequestDetail = {
  request: ResearchRequest;
  results: ResearchResult[];
  syntheses: ResearchSynthesis[];
};

export const researchRequestKindLabels: Record<ResearchRequestKind, string> = {
  project_watch: "Project Watch",
  decision: "Decision",
};

export const researchRequestStatusLabels: Record<ResearchRequestStatus, string> = {
  requested: "Requested",
  running: "Running",
  completed: "Completed",
  insufficient: "Insufficient",
  not_needed: "Not needed",
  cancelled: "Cancelled",
};

export const closedResearchRequestStatuses: ResearchRequestStatus[] = [
  "completed",
  "insufficient",
  "not_needed",
  "cancelled",
];
