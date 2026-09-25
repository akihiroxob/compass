export type DirectionDecisionType =
  | "next_outcome"
  | "additional_research"
  | "intent_complete"
  | "intent_abandon"
  | "policy_proposal"
  | "adr_candidate";

export type UsedSynthesisReference = { synthesisId: string; version: number };

export type IntentResearchRequestSummary = {
  id: string;
  status: string;
  question: string;
  budgetTotal: number;
  budgetUsed: number;
  deadlineAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type IntentResearchSynthesisSummary = {
  requestId: string;
  synthesisId: string;
  version: number;
  conclusion: string;
  risks: string[];
  options: string[];
  unknowns: string[];
  findingIds: string[];
  validAsOf: number;
  stale: boolean;
};

export type IntentResearchConflict = { findingId: string; conflictsWithFindingId: string };

export type IntentResearchSummary = {
  requests: IntentResearchRequestSummary[];
  syntheses: IntentResearchSynthesisSummary[];
  conflicts: IntentResearchConflict[];
};

export type DirectionDecision = {
  id: string;
  projectId: string;
  intentId: string;
  outcomeId: string | null;
  /** 根拠にしたOutcome Evaluation（Task 36）。Evaluationを根拠にしない判断は`null`。 */
  evaluationId: string | null;
  type: DirectionDecisionType;
  judgment: string;
  reason: string;
  options: string[];
  usedSyntheses: UsedSynthesisReference[];
  usedFindingIds: string[];
  principalId: string;
  runRef: string;
  intentBriefSnapshot: IntentResearchSummary;
  createdAt: number;
};

export const directionDecisionTypeLabels: Record<DirectionDecisionType, string> = {
  next_outcome: "Next Outcome",
  additional_research: "Additional Research",
  intent_complete: "Intent Complete",
  intent_abandon: "Intent Abandon",
  policy_proposal: "Policy Proposal",
  adr_candidate: "ADR Candidate",
};
