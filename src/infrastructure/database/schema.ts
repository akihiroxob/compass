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
};

export type DatabaseMetadata = Generated<number>;
