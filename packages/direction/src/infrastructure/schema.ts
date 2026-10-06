import type { Generated } from "kysely";

export type IntentTable = {
  id: string;
  workspace_id: string;
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
  workspace_id: string;
  intent_id: string;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: "active" | "evaluating" | "achieved" | "not_achieved" | "cancelled";
  cancel_reason: string | null;
  /** 判断したDirection DecisionのID。FKは意図的に付けない（direction_decision.outcome_idとの循環参照を避けるため）。 */
  origin_decision_id: string | null;
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

/** `unknowns` / `options` / `risks`は不変な文字列配列のJSON。要素単位では検索しない。 */
export type ResearchRequestTable = {
  id: string;
  workspace_id: string;
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
  workspace_id: string;
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
  workspace_id: string;
  result_id: string;
  position: number;
  kind: "url" | "repository_file" | "issue" | "pull_request" | "ci" | "wacha_run";
  uri: string;
  retrieved_at: number;
  version_hash: string | null;
  resource_id: string | null;
};

export type ResearchFindingTable = {
  id: string;
  workspace_id: string;
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
  workspace_id: string;
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

/** Compassを正本とするDirection Decision。作成後は変更しない（追記のみ）。 */
export type DirectionDecisionTable = {
  id: string;
  workspace_id: string;
  intent_id: string;
  /** next_outcomeのときだけ設定される。outcome.idへのFK。 */
  outcome_id: string | null;
  type:
    | "next_outcome"
    | "additional_research"
    | "intent_complete"
    | "intent_abandon"
    | "policy_proposal"
    | "adr_candidate";
  judgment: string;
  reason: string;
  /** JSON文字列の配列。 */
  options: string;
  /** 判断時点のIntent Brief snapshot（JSON）。 */
  intent_brief_snapshot: string;
  /** 根拠にしたOutcome Evaluation（Task 36）。1つのEvaluationを根拠にできるDecisionは1件だけ。 */
  evaluation_id: string | null;
  principal_id: string;
  run_ref: string;
  request_key: string;
  input_hash: string;
  created_at: number;
};

export type DirectionDecisionSynthesisTable = {
  decision_id: string;
  synthesis_id: string;
  version: number;
  position: number;
};

export type DirectionDecisionFindingTable = {
  decision_id: string;
  finding_id: string;
  position: number;
};

/** `adr_candidate` DecisionからWachaへ渡す依頼のfixture。作成後は変更しない。`payload`はJSON snapshot。 */
export type AdrHandoffRequestTable = {
  id: string;
  workspace_id: string;
  project_id: string;
  decision_id: string;
  repository_id: string;
  correlation_id: string;
  request_key: string;
  input_hash: string;
  payload: string;
  principal_id: string;
  created_at: number;
};

/** Wachaが完了させたADR作成結果の参照。本文は複製せず、path / commit SHA / PR URLだけを保持する。 */
export type AdrReferenceTable = {
  id: string;
  workspace_id: string;
  project_id: string;
  decision_id: string;
  repository_id: string;
  path: string;
  commit_sha: string;
  pull_request_url: string | null;
  correlation_id: string;
  request_key: string;
  input_hash: string;
  principal_id: string;
  created_at: number;
};

/** 状態変更と同一transactionで追記する確定イベント。更新・削除しない。`sequence`が取得位置（cursor）になる。 */
export type RuntimeEventTable = {
  sequence: Generated<number>;
  id: string;
  event_version: number;
  event_type: "research_requested" | "research_completed" | "outcome_confirmed" | "outcome_evaluated";
  project_id: string;
  intent_id: string | null;
  /** research系イベントの発端Request。`outcome_confirmed`ではnull。 */
  research_request_id: string | null;
  /** `outcome_confirmed`で確定した・`outcome_evaluated`で評価したOutcome。research系イベントではnull。 */
  outcome_id: string | null;
  /** `outcome_evaluated`で確定したEvaluation。他のイベントではnull。 */
  evaluation_id: string | null;
  correlation_id: string;
  conclusion: "completed" | "insufficient" | "not_needed" | null;
  created_at: number;
};

/** consumer（Runtime）ごとのイベント処理結果。行が無いイベントは未処理。`retryable_failure`以外は確定で、再配信しない。 */
export type RuntimeEventDeliveryTable = {
  consumer_id: string;
  event_sequence: number;
  project_id: string;
  outcome: "processed" | "retryable_failure" | "terminal_failure";
  retry_count: number;
  last_failure_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type RuntimeEventAckAttemptTable = {
  consumer_id: string;
  event_sequence: number;
  attempt_id: string;
  project_id: string;
  input_json: string;
  result_json: string;
  created_at: number;
};

/**
 * Executionの結果の要約（Direction所有）。Outcomeごとに1行。`stories`はJSON。Execution側のtableは参照せず、
 * ポート経由で受け取った値だけを保存する。`execution_cursor`が進むときだけ上書きする。
 */
export type OutcomeExecutionSummaryTable = {
  project_id: string;
  outcome_id: string;
  correlation_id: string;
  state: "accepted" | "rejected" | "canceled" | "incomplete";
  stories: string;
  execution_cursor: number;
  observed_cursor: number;
  principal_id: string;
  updated_at: number;
};

/** ExecutionがOutcomeへ残したEvidenceへの参照（本文は持たない）。作成後は変更しない。 */
export type OutcomeExecutionEvidenceTable = {
  id: string;
  project_id: string;
  outcome_id: string;
  kind: "commit" | "pull_request" | "repository_file" | "ci" | "issue" | "url";
  uri: string;
  version_hash: string | null;
  observed_at: number;
  source_change_cursor: number;
  principal_id: string;
  created_at: number;
};

/**
 * Outcomeの評価（Direction所有）。追記だけで更新しない。`criteria` / `snapshot`はJSON。Execution側のtableへのFKは持たず、
 * 評価時のExecution Summary・Evidence参照を`snapshot`へ写す。`(project_id, request_key)`で再送を1件に収束させる。
 */
export type OutcomeEvaluationTable = {
  id: string;
  project_id: string;
  outcome_id: string;
  intent_id: string;
  result: "achieved" | "failed" | "insufficient_evidence";
  criteria: string;
  snapshot: string;
  principal_id: string;
  run_ref: string;
  request_key: string;
  input_hash: string;
  created_at: number;
};

/**
 * Directionが所有するtable。単一SQLite fileの一部で、serverが他Contextのtableと合成する。
 * Intent/Outcome/Research/Decision/ADRの`workspace_id`、artifactと未切替Entityの`project_id`のFK先はOrganizationが所有する。
 * DirectionはWorkspace/Projectの状態をserverが渡すreaderで読む。
 */
export type DirectionDatabase = {
  intent: IntentTable;
  outcome: OutcomeTable;
  success_criterion: SuccessCriterionTable;
  research_request: ResearchRequestTable;
  research_result: ResearchResultTable;
  research_evidence_ref: ResearchEvidenceRefTable;
  research_finding: ResearchFindingTable;
  research_finding_evidence: ResearchFindingEvidenceTable;
  research_finding_conflict: ResearchFindingConflictTable;
  research_synthesis: ResearchSynthesisTable;
  research_synthesis_finding: ResearchSynthesisFindingTable;
  direction_decision: DirectionDecisionTable;
  direction_decision_synthesis: DirectionDecisionSynthesisTable;
  direction_decision_finding: DirectionDecisionFindingTable;
  adr_handoff_request: AdrHandoffRequestTable;
  adr_reference: AdrReferenceTable;
  runtime_event: RuntimeEventTable;
  runtime_event_delivery: RuntimeEventDeliveryTable;
  runtime_event_ack_attempt: RuntimeEventAckAttemptTable;
  outcome_execution_summary: OutcomeExecutionSummaryTable;
  outcome_execution_evidence: OutcomeExecutionEvidenceTable;
  outcome_evaluation: OutcomeEvaluationTable;
};
