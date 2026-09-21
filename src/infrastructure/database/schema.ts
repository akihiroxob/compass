import type { Generated } from "kysely";

export type ProjectTable = {
  id: string;
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  created_at: number;
  updated_at: number;
  status: "active" | "archived";
  archived_at: number | null;
  archive_reason: string | null;
};

type OrderedTextTable = {
  id: string;
  project_id: string;
  value: string;
  sort_order: number;
};

export type ProjectRepositoryLinkTable = {
  id: string;
  project_id: string;
  name: string;
  url: string;
  sort_order: number;
};

export type ProjectResourceTable = ProjectRepositoryLinkTable & {
  kind: string | null;
};

export type IntentTable = {
  id: string;
  project_id: string;
  title: string;
  desired_state: string;
  completion_definition: string | null;
  status: "active" | "achieved" | "abandoned";
  abandoned_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type OutcomeTable = {
  id: string;
  project_id: string;
  intent_id: string;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: "active" | "evaluating" | "achieved" | "not_achieved" | "cancelled";
  cancel_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type SuccessCriterionTable = {
  id: string;
  outcome_id: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
  created_at: number;
};

export type ProjectGrantTable = {
  project_id: string;
  principal_id: string;
  role: string;
  created_at: number;
};

/** `unknowns` / `options` / `risks`は不変な文字列配列のJSON。要素単位では検索しない。 */
export type ResearchRequestTable = {
  id: string;
  project_id: string;
  request_key: string;
  input_hash: string;
  kind: "project_watch" | "decision";
  origin_intent_id: string | null;
  origin_outcome_id: string | null;
  question: string;
  scope: string;
  completion_condition: string;
  budget_total: number;
  budget_used: number;
  deadline_at: number | null;
  status: "requested" | "running" | "completed" | "insufficient" | "not_needed" | "cancelled";
  stop_reason: string | null;
  correlation_id: string;
  created_at: number;
  updated_at: number;
};

export type ResearchResultTable = {
  id: string;
  project_id: string;
  request_id: string;
  sequence: number;
  request_key: string;
  input_hash: string;
  summary: string;
  unknowns: string;
  options: string;
  risks: string;
  budget_used: number;
  principal_id: string;
  run_ref: string;
  created_at: number;
};

export type ResearchEvidenceRefTable = {
  id: string;
  project_id: string;
  result_id: string;
  position: number;
  kind: "url" | "repository_file" | "issue" | "pull_request" | "ci" | "wacha_run";
  uri: string;
  retrieved_at: number;
  version_hash: string | null;
};

export type ResearchFindingTable = {
  id: string;
  project_id: string;
  request_id: string;
  result_id: string;
  position: number;
  statement: string;
  confidence: "low" | "medium" | "high";
  observed_at: number;
  expires_at: number | null;
  principal_id: string;
  run_ref: string;
  created_at: number;
};

export type ResearchFindingEvidenceTable = {
  finding_id: string;
  evidence_ref_id: string;
  position: number;
};

export type ResearchFindingConflictTable = {
  finding_id: string;
  conflicting_finding_id: string;
};

export type ResearchSynthesisTable = {
  id: string;
  project_id: string;
  request_id: string;
  request_key: string;
  input_hash: string;
  version: number;
  supersedes_id: string | null;
  conclusion: string;
  risks: string;
  options: string;
  unknowns: string;
  valid_as_of: number;
  principal_id: string;
  run_ref: string;
  created_at: number;
};

export type ResearchSynthesisFindingTable = {
  synthesis_id: string;
  finding_id: string;
  position: number;
};

export type Database = {
  project: ProjectTable;
  project_principle: OrderedTextTable;
  project_constraint: OrderedTextTable;
  project_repository_link: ProjectRepositoryLinkTable;
  project_resource: ProjectResourceTable;
  intent: IntentTable;
  outcome: OutcomeTable;
  success_criterion: SuccessCriterionTable;
  project_grant: ProjectGrantTable;
  research_request: ResearchRequestTable;
  research_result: ResearchResultTable;
  research_evidence_ref: ResearchEvidenceRefTable;
  research_finding: ResearchFindingTable;
  research_finding_evidence: ResearchFindingEvidenceTable;
  research_finding_conflict: ResearchFindingConflictTable;
  research_synthesis: ResearchSynthesisTable;
  research_synthesis_finding: ResearchSynthesisFindingTable;
};

export type DatabaseMetadata = Generated<number>;
