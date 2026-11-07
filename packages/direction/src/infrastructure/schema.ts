import type { Generated } from "kysely";

export type IntentTable = {
  id: string;
  workspace_id: string;
  title: string;
  desired_state: string;
  background: string | null;
  audience: string | null;
  constraints: string | null;
  completion_definition: string | null;
  /** `YYYY-MM-DD`の暦日。 */
  target_date: string | null;
  status: "active" | "achieved" | "abandoned";
  abandoned_reason: string | null;
  /** 保存のたびに1ずつ増える版。作成時は1。更新は呼び出し側が持つ版との一致を条件にする。 */
  version: number;
  /** desiredState / completionDefinitionが最後に変わった版。これより古い版を根拠にした未完了のOutcomeは再計画の対象。 */
  meaning_version: number;
  created_at: number;
  updated_at: number;
};

/** Intentの版ごとの内容・変更主体・理由。追記だけで更新しない。版1は作成時の内容。 */
export type IntentRevisionTable = {
  intent_id: string;
  workspace_id: string;
  version: number;
  title: string;
  desired_state: string;
  background: string | null;
  audience: string | null;
  constraints: string | null;
  completion_definition: string | null;
  target_date: string | null;
  /** この版でdesiredState / completionDefinitionが変わったか。 */
  meaning_changed: number;
  reason: string | null;
  changed_by: string;
  changed_by_role: string;
  created_at: number;
};

export type OutcomeTable = {
  id: string;
  workspace_id: string;
  intent_id: string;
  /** 作成または最後に再確認した時点のIntentの版。 */
  intent_version: number;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: "active" | "evaluating" | "achieved" | "not_achieved" | "cancelled";
  cancel_reason: string | null;
  /** 判断したDirection DecisionのID。FKは意図的に付けない（direction_decision.outcome_idとの循環参照を避けるため）。 */
  origin_decision_id: string | null;
  /** 更新のたびに1増える版（作成時1）。 */
  revision: number;
  created_at: number;
  updated_at: number;
};

/** Outcomeの課題（Problem Statement）と根拠の状態・観測・原因の仮説・解決策の仮説。Outcomeの一部として置換で更新する。 */
export type OutcomeProblemTable = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  position: number;
  statement: string;
  evidence_status: "insufficient" | "observed" | "refuted";
  observation: string | null;
  cause_hypothesis: string | null;
  solution_hypothesis: string | null;
  /** 評価計画のJSON（`EvaluationPlan`）。未記録はnull。 */
  evaluation_plan: string | null;
  created_at: number;
  updated_at: number;
};

/** 課題の根拠参照。同じWorkspaceのResearch Finding・Synthesisのどちらか1つを複合FKで参照する。 */
export type OutcomeProblemEvidenceTable = {
  problem_id: string;
  workspace_id: string;
  position: number;
  finding_id: string | null;
  synthesis_id: string | null;
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

/** OutcomeとTarget Projectの関連。Workspace一致はRepositoryが書込と同一transactionで検査する。 */
export type OutcomeTargetProjectTable = {
  outcome_id: string;
  project_id: string;
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
  /** 判断した時点のIntentの版。内容は`intent_revision`で参照する。 */
  intent_version: number;
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
  workspace_id: string;
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
  workspace_id: string;
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
  workspace_id: string;
  input_json: string;
  result_json: string;
  created_at: number;
};

/**
 * Executionの結果の要約（Direction所有）。Outcome・Projectごとに1行。`stories`はJSON。Execution側のtableは参照せず、
 * ポート経由で受け取った値だけを保存する。`execution_cursor`が進むときだけ上書きする。
 */
export type OutcomeExecutionSummaryTable = {
  workspace_id: string;
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
  workspace_id: string;
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
 * 評価時のExecution Summary・Evidence参照を`snapshot`へ写す。`(workspace_id, request_key)`で再送を1件に収束させる。
 */
export type OutcomeEvaluationTable = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  intent_id: string;
  /** 評価したOutcomeが根拠にしていたIntentの版。 */
  intent_version: number;
  result: "achieved" | "failed" | "insufficient_evidence";
  method: string;
  target_version: string;
  limitations: string;
  /** 評価対象の課題idのJSON配列。 */
  problem_ids: string;
  /** 評価時点の評価計画のJSON配列（`{ problemId, planId }`）。 */
  problem_plans: string;
  criteria: string;
  snapshot: string;
  principal_id: string;
  run_ref: string;
  request_key: string;
  input_hash: string;
  created_at: number;
};

/**
 * Intentの観測項目（Direction所有）。`(intent_id, key)`で一意。単位・目標値・鮮度の期限を明示的に持ち、説明文から生成しない。
 */
export type IntentMetricTable = {
  id: string;
  workspace_id: string;
  intent_id: string;
  key: string;
  name: string;
  unit: string;
  target_value: number | null;
  stale_after_days: number;
  revision: number;
  created_by_principal_id: string;
  created_at: number;
  updated_at: number;
};

/**
 * 観測項目の観測値。対象期間（暦日）ごとの版を追記し、更新しない。`(metric_id, period_start, period_end, revision)`で一意。
 * `observed`は値あり、`failed`は値なし・理由あり（checkで保証）。
 */
export type IntentMetricObservationTable = {
  id: string;
  metric_id: string;
  period_start: string;
  period_end: string;
  revision: number;
  status: "observed" | "failed";
  value: number | null;
  failure_reason: string | null;
  source_name: string;
  source_uri: string | null;
  observed_at: number;
  principal_id: string;
  recorded_at: number;
};

/**
 * Intentの観測についてのAgentの説明（追記のみ）。`(intent_id, metric_key, version)`で一意。参照先の本文・値は保持しない。
 */
export type IntentExplanationTable = {
  id: string;
  workspace_id: string;
  intent_id: string;
  metric_key: string;
  period_start: string;
  period_end: string;
  version: number;
  previous_id: string | null;
  change_from_previous: string | null;
  principal_id: string;
  run_ref: string;
  request_key: string;
  input_hash: string;
  created_at: number;
};

export type IntentExplanationItemTable = {
  explanation_id: string;
  position: number;
  kind: "fact" | "hypothesis" | "proposal";
  statement: string;
  confidence: "low" | "medium" | "high" | null;
  verification: string | null;
  /** 先行する項目の位置のJSON配列。 */
  based_on: string;
};

/** 項目の根拠。観測値・Finding・Synthesis・Evaluation・Decisionのうち1つを参照する。 */
export type IntentExplanationBasisTable = {
  explanation_id: string;
  workspace_id: string;
  item_position: number;
  position: number;
  observation_id: string | null;
  finding_id: string | null;
  synthesis_id: string | null;
  evaluation_id: string | null;
  decision_id: string | null;
};

export type IntentExplanationOutcomeTable = {
  explanation_id: string;
  workspace_id: string;
  outcome_id: string;
  position: number;
};

/**
 * Directionが所有するtable。単一SQLite fileの一部で、serverが他Contextのtableと合成する。
 * Workspace所有の`workspace_id`、artifactとExecutionの発生元の`project_id`のFK先はOrganizationが所有する。
 * DirectionはWorkspace/Projectの状態をserverが渡すreaderで読む。
 */
export type DirectionDatabase = {
  intent: IntentTable;
  intent_revision: IntentRevisionTable;
  outcome: OutcomeTable;
  success_criterion: SuccessCriterionTable;
  outcome_problem: OutcomeProblemTable;
  outcome_problem_evidence: OutcomeProblemEvidenceTable;
  outcome_target_project: OutcomeTargetProjectTable;
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
  intent_explanation: IntentExplanationTable;
  intent_explanation_item: IntentExplanationItemTable;
  intent_explanation_basis: IntentExplanationBasisTable;
  intent_explanation_outcome: IntentExplanationOutcomeTable;
  intent_metric: IntentMetricTable;
  intent_metric_observation: IntentMetricObservationTable;
};
