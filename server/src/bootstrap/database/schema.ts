import type { Generated } from "kysely";
import type { DirectionDatabase } from "@compass/direction";

export type ProjectGrantTable = {
  project_id: string;
  principal_id: string;
  role: string;
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

/** 単一SQLite fileの全table。各Contextが所有するtable定義をserverが合成する。 */
export type Database = DirectionDatabase & {
  story: StoryTable;
  task: TaskTable;
  task_comment: TaskCommentTable;
  task_claim: TaskClaimTable;
  change_log: ChangeLogTable;
  command_receipt: CommandReceiptTable;
  project_grant: ProjectGrantTable;
  human_user: HumanUserTable;
  human_identity: HumanIdentityTable;
  web_session: WebSessionTable;
  auth_login_attempt: AuthLoginAttemptTable;
  project_membership: ProjectMembershipTable;
  project_invitation: ProjectInvitationTable;
  access_credential: AccessCredentialTable;
};

export type DatabaseMetadata = Generated<number>;
