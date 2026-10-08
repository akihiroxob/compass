/** Accessが所有するtable。Project・Workspaceの行（Organization）はFKで参照するだけで、Accessは読み書きしない。 */
export type ProjectGrantTable = {
  project_id: string;
  principal_id: string;
  role: string;
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

/** Workspace（Organization）単位のHuman Membership。Project Membershipとは別tableで、相互に継承しない。 */
export type WorkspaceMembershipTable = {
  id: string;
  workspace_id: string;
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
/** scopeに対応するIDの列だけを持つ（CHECK制約）。 */
export type AccessCredentialTable = {
  id: string;
  scope_kind: "workspace" | "project";
  workspace_id: string | null;
  project_id: string | null;
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

/** Workspace DirectionのRole Grant。ProjectのGrantとは独立する。 */
export type WorkspaceGrantTable = {
  workspace_id: string;
  principal_id: string;
  role: string;
  created_at: number;
};

export type AccessDatabase = {
  workspace_grant: WorkspaceGrantTable;
  project_grant: ProjectGrantTable;
  human_user: HumanUserTable;
  human_identity: HumanIdentityTable;
  web_session: WebSessionTable;
  auth_login_attempt: AuthLoginAttemptTable;
  project_membership: ProjectMembershipTable;
  project_invitation: ProjectInvitationTable;
  workspace_membership: WorkspaceMembershipTable;
  access_credential: AccessCredentialTable;
};
