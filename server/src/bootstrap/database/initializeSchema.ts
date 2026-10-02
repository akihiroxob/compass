import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import { initializeDirectionSchema } from "@compass/direction";
import { asDirectionDatabase } from "./contextDatabase.ts";
import type { Database } from "./schema.ts";

/**
 * Task 33差し戻し対応以前のDBの`task`には`task_key`列が無い。列が無い場合だけ追加する（idempotent）。
 * 既存行はNULL（論理IDなし）のままで、旧Wachaの`requestId`だけの契約として扱う。
 */
const addTaskKeyColumn = async (database: Kysely<Database>): Promise<void> => {
  const columns = await sql<{ name: string }>`select name from pragma_table_info('task')`.execute(database);
  if (columns.rows.some(({ name }) => name === "task_key")) return;
  await sql`alter table task add column task_key text`.execute(database);
};

/**
 * Execution（旧Wachaから移植したStory / Task / Claim / Comment / Change Log / Command Receipt）。
 * すべて`create ... if not exists`で、Direction側のtableには触れない。Directionへの参照（`story.outcome_ref`等）は
 * 境界をまたぐためFKを付けず、作成時のsnapshotで保持する。`project_id`は統合した既存`project.id`を使う。
 */
const initializeExecutionSchema = async (database: Kysely<Database>): Promise<void> => {
  const projectId = (column: ColumnDefinitionBuilder) =>
    column.notNull().references("project.id").onDelete("cascade");

  await database.schema
    .createTable("story")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("title", "text", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("status", "text", (column) =>
      column.notNull().check(sql`status in ('todo', 'doing', 'done', 'canceled')`),
    )
    .addColumn("sort_order", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("outcome_ref", "text")
    .addColumn("origin_decision_id", "text")
    .addColumn("success_criteria_snapshot", "text")
    .addColumn("constraints_snapshot", "text")
    .addColumn("repository_snapshot", "text")
    .addColumn("correlation_id", "text")
    .execute();
  await database.schema
    .createIndex("story_project_idx")
    .ifNotExists()
    .on("story")
    .column("project_id")
    .execute();
  // DirectionからのhandoffをProject内で一意にする。NULLは重複として扱われないため、手動起票のStoryは制約を受けない。
  await database.schema
    .createIndex("story_project_correlation_idx")
    .unique()
    .ifNotExists()
    .on("story")
    .columns(["project_id", "correlation_id"])
    .execute();

  await database.schema
    .createTable("task")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("story_id", "text", (column) => column.references("story.id"))
    .addColumn("title", "text", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("assignee", "text")
    .addColumn("reject_reason", "text")
    .addColumn("resume_source_status", "text")
    .addColumn("sort_order", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("task_key", "text")
    .execute();
  await addTaskKeyColumn(database);
  await database.schema.createIndex("task_project_idx").ifNotExists().on("task").column("project_id").execute();
  await database.schema.createIndex("task_story_idx").ifNotExists().on("task").column("story_id").execute();
  // Outcome handoffのTaskをStory内の論理ID（taskKey）で一意にする。NULLは対象外なので手動起票のTaskは制約を受けない。
  await sql`create unique index if not exists task_story_key_idx on task(story_id, task_key) where task_key is not null`.execute(
    database,
  );

  await database.schema
    .createTable("task_comment")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("task_id", "text", (column) => column.notNull().references("task.id"))
    .addColumn("body", "text", (column) => column.notNull())
    .addColumn("author", "text")
    .addColumn("principal_id", "text")
    .addColumn("claim_id", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("task_comment_task_idx")
    .ifNotExists()
    .on("task_comment")
    .column("task_id")
    .execute();

  await database.schema
    .createTable("task_claim")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("task_id", "text", (column) => column.notNull().references("task.id").onDelete("cascade"))
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("acquired_at", "integer", (column) => column.notNull())
    .addColumn("renewed_at", "integer")
    .addColumn("expires_at", "integer", (column) => column.notNull())
    .addColumn("released_at", "integer")
    .addColumn("release_reason", "text")
    .execute();
  await database.schema
    .createIndex("task_claim_task_state_idx")
    .ifNotExists()
    .on("task_claim")
    .columns(["task_id", "state"])
    .execute();
  // 1 Taskに有効なClaimは最大1件。同時のclaimはこの制約で1件だけが成立する（CLAIM_CONFLICT）。
  await sql`create unique index if not exists task_claim_active_task_idx on task_claim(task_id) where state = 'active'`.execute(
    database,
  );

  await database.schema
    .createTable("change_log")
    .ifNotExists()
    .addColumn("cursor", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("project_id", "text", projectId)
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("entity_id", "text", (column) => column.notNull())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("claim_id", "text")
    .addColumn("payload", "text", (column) => column.notNull())
    .addColumn("occurred_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("change_log_project_cursor_idx")
    .ifNotExists()
    .on("change_log")
    .columns(["project_id", "cursor"])
    .execute();
  // 直前のTASK_COMPLETEDの主体（自己review・自己受入の判定）を引くための索引。
  await database.schema
    .createIndex("change_log_entity_type_idx")
    .ifNotExists()
    .on("change_log")
    .columns(["entity_id", "type"])
    .execute();

  await database.schema
    .createTable("command_receipt")
    .ifNotExists()
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("tool_name", "text", (column) => column.notNull())
    .addColumn("request_id", "text", (column) => column.notNull())
    .addColumn("input_json", "text", (column) => column.notNull())
    .addColumn("result_json", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("command_receipt_pk", ["principal_id", "tool_name", "request_id"])
    .execute();
};

/**
 * Human認証（docs/step-6-human-auth-design.md）。すべて`create ... if not exists`で既存tableには触れない。
 * 既存Projectはowner不在（orphan）のまま残り、初期ownerのbootstrap時にowner Membershipを補完する。
 * Session・招待・ログイン試行のsecretはSHA-256だけを保存し、平文の列を持たない。
 */
const initializeHumanAuthSchema = async (database: Kysely<Database>): Promise<void> => {
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

/** Agent・Runtime向けCredential（Task 37）。既存tableは変更しない。 */
const initializeAccessCredentialSchema = async (database: Kysely<Database>) => {
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

export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeDirectionSchema(asDirectionDatabase(database));

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

  await initializeExecutionSchema(database);
  await initializeHumanAuthSchema(database);
  await initializeAccessCredentialSchema(database);
};
