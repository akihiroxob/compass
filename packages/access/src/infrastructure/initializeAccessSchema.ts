import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import type { AccessDatabase } from "./schema.ts";

/** Role Grant。Agent・RuntimeのPrincipalへProject単位で割り当てる。 */
const initializeProjectGrantSchema = async (database: Kysely<AccessDatabase>): Promise<void> => {
  // roleにcheck制約は置かない。Roleの追加でtable再作成を要さないよう、検証はapplication層（projectGrantSchema）で行う。
  // 主キーが再発行の冪等性を担保する。
  await database.schema
    .createTable("project_grant")
    .ifNotExists()
    .addColumn("project_id", "text", (column) =>
      column.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("project_grant_pk", ["project_id", "principal_id", "role"])
    .execute();
  await database.schema
    .createIndex("project_grant_principal_id_project_id_idx")
    .ifNotExists()
    .on("project_grant")
    .columns(["principal_id", "project_id"])
    .execute();
};

/**
 * Human認証（docs/step-6-human-auth-design.md）。すべて`create ... if not exists`で既存tableには触れない。
 * 既存Projectはowner不在（orphan）のまま残り、初期ownerのbootstrap時にowner Membershipを補完する。
 * Session・招待・ログイン試行のsecretはSHA-256だけを保存し、平文の列を持たない。
 */
const initializeHumanAuthSchema = async (database: Kysely<AccessDatabase>): Promise<void> => {
  const humanUserId = (column: ColumnDefinitionBuilder) => column.references("human_user.id");
  const humanRole = sql`('owner', 'administrator', 'editor', 'viewer')`;

  await database.schema
    .createTable("human_user")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("display_name", "text", (column) => column.notNull())
    .addColumn("email", "text", (column) => column.notNull())
    .addColumn("platform_role", "text", (column) => column.notNull().check(sql`platform_role in ('owner', 'member')`))
    .addColumn("status", "text", (column) => column.notNull().check(sql`status in ('active', 'disabled')`))
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .execute();
  // platform owner（最初にbootstrapされたHuman）は最大1件。同時のbootstrapもこの制約で1件に限る。
  await sql`create unique index if not exists human_user_platform_owner_idx
    on human_user (platform_role) where platform_role = 'owner'`.execute(database);

  await database.schema
    .createTable("human_identity")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("human_user_id", "text", (column) => humanUserId(column).notNull())
    .addColumn("provider", "text", (column) => column.notNull().check(sql`provider in ('google', 'local')`))
    .addColumn("issuer", "text", (column) => column.notNull())
    .addColumn("subject", "text", (column) => column.notNull())
    .addColumn("email_at_login", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("last_login_at", "integer", (column) => column.notNull())
    .execute();
  // 本人識別の正本。email変更で別Humanを作らない。
  await database.schema
    .createIndex("human_identity_provider_subject_idx")
    .unique()
    .ifNotExists()
    .on("human_identity")
    .columns(["provider", "issuer", "subject"])
    .execute();
  await database.schema
    .createIndex("human_identity_human_provider_idx")
    .unique()
    .ifNotExists()
    .on("human_identity")
    .columns(["human_user_id", "provider"])
    .execute();

  await database.schema
    .createTable("web_session")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("token_hash", "text", (column) => column.notNull().unique())
    .addColumn("human_user_id", "text", (column) => humanUserId(column).notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("last_seen_at", "integer", (column) => column.notNull())
    .addColumn("expires_at", "integer", (column) => column.notNull())
    .addColumn("revoked_at", "integer")
    .addColumn("revoke_reason", "text", (column) =>
      column.check(sql`revoke_reason in ('logout', 'human_disabled', 'superseded')`),
    )
    .execute();
  await database.schema
    .createIndex("web_session_human_idx")
    .ifNotExists()
    .on("web_session")
    .column("human_user_id")
    .execute();

  await database.schema
    .createTable("auth_login_attempt")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("provider", "text", (column) => column.notNull().check(sql`provider in ('google', 'local')`))
    .addColumn("state", "text")
    .addColumn("nonce", "text")
    .addColumn("code_verifier", "text")
    .addColumn("return_to", "text", (column) => column.notNull())
    .addColumn("invitation_token_hash", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("expires_at", "integer", (column) => column.notNull())
    .addColumn("consumed_at", "integer")
    .execute();

  await database.schema
    .createTable("project_membership")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) => column.notNull().references("project.id").onDelete("cascade"))
    .addColumn("human_user_id", "text", (column) => humanUserId(column).notNull())
    .addColumn("role", "text", (column) => column.notNull().check(sql`role in ${humanRole}`))
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("created_by_human_user_id", "text", humanUserId)
    .addColumn("revoked_at", "integer")
    .addColumn("revoked_by_human_user_id", "text", humanUserId)
    .execute();
  // 有効なMembershipは(Project, Human)につき1件。取消後の再招待は新しい行にする。
  await sql`create unique index if not exists project_membership_active_idx
    on project_membership (project_id, human_user_id) where revoked_at is null`.execute(database);
  await database.schema
    .createIndex("project_membership_human_idx")
    .ifNotExists()
    .on("project_membership")
    .column("human_user_id")
    .execute();

  await database.schema
    .createTable("project_invitation")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) => column.notNull().references("project.id").onDelete("cascade"))
    .addColumn("email", "text", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull().check(sql`role in ${humanRole}`))
    .addColumn("token_hash", "text", (column) => column.notNull().unique())
    .addColumn("status", "text", (column) =>
      column.notNull().check(sql`status in ('pending', 'accepted', 'revoked')`),
    )
    .addColumn("expires_at", "integer", (column) => column.notNull())
    .addColumn("created_by_human_user_id", "text", (column) => humanUserId(column).notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("accepted_by_human_user_id", "text", humanUserId)
    .addColumn("accepted_at", "integer")
    .addColumn("revoked_by_human_user_id", "text", humanUserId)
    .addColumn("revoked_at", "integer")
    .execute();
  // 同じ宛先の未使用招待は1件。再発行は取消してから行う（上書きしない）。
  await sql`create unique index if not exists project_invitation_pending_idx
    on project_invitation (project_id, email) where status = 'pending'`.execute(database);
};

/** Workspace Membership。`create ... if not exists`だけで既存tableには触れない。既存Projectからの初期memberは別途補完する。 */
const initializeWorkspaceMembershipSchema = async (database: Kysely<AccessDatabase>): Promise<void> => {
  const humanUserId = (column: ColumnDefinitionBuilder) => column.references("human_user.id");
  await database.schema
    .createTable("workspace_membership")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("workspace_id", "text", (column) => column.notNull().references("workspace.id").onDelete("cascade"))
    .addColumn("human_user_id", "text", (column) => humanUserId(column).notNull())
    .addColumn("role", "text", (column) =>
      column.notNull().check(sql`role in ('owner', 'administrator', 'editor', 'viewer')`),
    )
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("created_by_human_user_id", "text", humanUserId)
    .addColumn("revoked_at", "integer")
    .addColumn("revoked_by_human_user_id", "text", humanUserId)
    .execute();
  // 有効なMembershipは(Workspace, Human)につき1件。取消後の再追加は新しい行にする。
  await sql`create unique index if not exists workspace_membership_active_idx
    on workspace_membership (workspace_id, human_user_id) where revoked_at is null`.execute(database);
  await database.schema
    .createIndex("workspace_membership_human_idx")
    .ifNotExists()
    .on("workspace_membership")
    .column("human_user_id")
    .execute();
};

/** Agent・Runtime向けCredential（Task 37）。既存tableは変更しない。 */
const initializeAccessCredentialSchema = async (database: Kysely<AccessDatabase>) => {
  await database.schema
    .createTable("access_credential")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) => column.notNull().references("project.id").onDelete("cascade"))
    .addColumn("kind", "text", (column) => column.notNull().check(sql`kind in ('agent', 'runtime')`))
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("scopes_json", "text", (column) => column.notNull())
    .addColumn("prefix", "text", (column) => column.notNull())
    .addColumn("secret_hash", "text", (column) => column.notNull().unique())
    .addColumn("expires_at", "integer", (column) => column.notNull())
    .addColumn("revoked_at", "integer")
    .addColumn("revoked_by_human_user_id", "text", (column) => column.references("human_user.id"))
    .addColumn("last_used_at", "integer")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("created_by_human_user_id", "text", (column) => column.notNull().references("human_user.id"))
    .addColumn("rotated_from_id", "text", (column) => column.references("access_credential.id"))
    .execute();
  await database.schema
    .createIndex("access_credential_project_idx")
    .ifNotExists()
    .on("access_credential")
    .column("project_id")
    .execute();
  await database.schema
    .createIndex("access_credential_principal_idx")
    .ifNotExists()
    .on("access_credential")
    .columns(["kind", "principal_id"])
    .execute();
};

/**
 * Accessのtable。すべて`create ... if not exists`なので既存DBへ再適用できる。
 * `project.id`・`workspace.id`へのFKを持つため、Organizationのschemaの後に適用する。
 */
export const initializeAccessSchema = async (database: Kysely<AccessDatabase>): Promise<void> => {
  await initializeProjectGrantSchema(database);
  await initializeHumanAuthSchema(database);
  await initializeWorkspaceMembershipSchema(database);
  await initializeAccessCredentialSchema(database);
};
