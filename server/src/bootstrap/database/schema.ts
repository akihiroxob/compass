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

/** Compassを正本とするDirection Decision。作成後は変更しない（追記のみ）。 */
export type DirectionDecisionTable = {
  id: string;
  project_id: string;
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
 * Execution（旧Wacha）のStory。Direction側のOutcomeは参照（`outcome_ref`）と作成時のsnapshotだけを持ち、
 * outcome / success_criterion / projectのtableを読み書きしない。snapshotはJSON文字列。
 */
export type StoryTable = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: "todo" | "doing" | "done" | "canceled";
  sort_order: number;
  created_at: number;
  updated_at: number;
  /** Direction `outcome.id`への参照。FKは付けない（境界をまたぐ参照のため）。 */
  outcome_ref: string | null;
  origin_decision_id: string | null;
  /** 作成時点の固定Success Criteria（JSON配列）。 */
  success_criteria_snapshot: string | null;
  /** 作成時点のProject Constraints（JSON配列）。 */
  constraints_snapshot: string | null;
  /** 対象Repository（`{id, name, url}`のJSON）。実際のcheckoutはRuntime / Agentの責務。 */
  repository_snapshot: string | null;
  /** DirectionからのhandoffをProject内で一意にする相関ID（例: `outcome:{outcomeId}`）。 */
  correlation_id: string | null;
};

export type TaskTable = {
  id: string;
  project_id: string;
  story_id: string | null;
  title: string;
  description: string | null;
  status: "todo" | "doing" | "canceled" | "in_review" | "wait_accept" | "accepted" | "rejected";
  assignee: string | null;
  reject_reason: string | null;
  resume_source_status: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  /** Story内で一意なTaskの論理ID（Outcome handoffの再送収束用）。手動起票ではNULL。 */
  task_key: string | null;
};

export type TaskCommentTable = {
  id: string;
  task_id: string;
  body: string;
  author: string | null;
  principal_id: string | null;
  claim_id: string | null;
  created_at: number;
};

export type TaskClaimTable = {
  id: string;
  task_id: string;
  principal_id: string;
  state: string;
  acquired_at: number;
  renewed_at: number | null;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
};

/** Executionの追記専用Change Log。`cursor`が取得位置になる。 */
export type ChangeLogTable = {
  cursor: Generated<number>;
  project_id: string;
  type: string;
  entity_id: string;
  principal_id: string;
  claim_id: string | null;
  payload: string;
  occurred_at: number;
};

/** Execution toolの`requestId`冪等性。同じ`(principal_id, tool_name, request_id)`は保存した結果を再生する。 */
export type CommandReceiptTable = {
  principal_id: string;
  tool_name: string;
  request_id: string;
  input_json: string;
  result_json: string;
  created_at: number;
};

/** Human認証（docs/step-6-human-auth-design.md）。token・secretは平文を持たずSHA-256だけを保存する。 */
export type HumanUserTable = {
  id: string;
  display_name: string;
  /** 表示と招待照合の補助。unique制約を付けない（本人識別はhuman_identity）。 */
  email: string;
  platform_role: "owner" | "member";
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
};

export type HumanIdentityTable = {
  id: string;
  human_user_id: string;
  provider: "google" | "local";
  issuer: string;
  subject: string;
  email_at_login: string;
  created_at: number;
  last_login_at: number;
};

export type WebSessionTable = {
  id: string;
  token_hash: string;
  human_user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: "logout" | "human_disabled" | "superseded" | null;
};

/** OIDCのstate / nonce / PKCE。操作はTask 41で実装する。`id`はログイン試行Cookie値のSHA-256。 */
export type AuthLoginAttemptTable = {
  id: string;
  provider: "google" | "local";
  state: string | null;
  nonce: string | null;
  code_verifier: string | null;
  return_to: string;
  invitation_token_hash: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

export type ProjectMembershipTable = {
  id: string;
  project_id: string;
  human_user_id: string;
  role: "owner" | "administrator" | "editor" | "viewer";
  created_at: number;
  updated_at: number;
  created_by_human_user_id: string | null;
  revoked_at: number | null;
  revoked_by_human_user_id: string | null;
};

export type ProjectInvitationTable = {
  id: string;
  project_id: string;
  email: string;
  role: "owner" | "administrator" | "editor" | "viewer";
  token_hash: string;
  status: "pending" | "accepted" | "revoked";
  expires_at: number;
  created_by_human_user_id: string;
  created_at: number;
  accepted_by_human_user_id: string | null;
  accepted_at: number | null;
  revoked_by_human_user_id: string | null;
  revoked_at: number | null;
};

/** Agent・Runtime向けCredential（Task 37）。secretは平文を持たずSHA-256だけを保存する。 */
export type AccessCredentialTable = {
  id: string;
  project_id: string;
  kind: "agent" | "runtime";
  principal_id: string;
  /** Runtime scopeの配列のJSON。agentは`[]`。 */
  scopes_json: string;
  prefix: string;
  secret_hash: string;
  expires_at: number;
  revoked_at: number | null;
  revoked_by_human_user_id: string | null;
  last_used_at: number | null;
  created_at: number;
  created_by_human_user_id: string;
  rotated_from_id: string | null;
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
  story: StoryTable;
  task: TaskTable;
  task_comment: TaskCommentTable;
  task_claim: TaskClaimTable;
  change_log: ChangeLogTable;
  command_receipt: CommandReceiptTable;
  human_user: HumanUserTable;
  human_identity: HumanIdentityTable;
  web_session: WebSessionTable;
  auth_login_attempt: AuthLoginAttemptTable;
  project_membership: ProjectMembershipTable;
  project_invitation: ProjectInvitationTable;
  access_credential: AccessCredentialTable;
};

export type DatabaseMetadata = Generated<number>;
