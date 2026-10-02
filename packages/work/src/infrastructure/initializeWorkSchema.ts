import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import type { WorkDatabase } from "./schema.ts";

/**
 * Task 33差し戻し対応以前のDBの`task`には`task_key`列が無い。列が無い場合だけ追加する（idempotent）。
 * 既存行はNULL（論理IDなし）のままで、旧Wachaの`requestId`だけの契約として扱う。
 */
const addTaskKeyColumn = async (database: Kysely<WorkDatabase>): Promise<void> => {
  const columns = await sql<{ name: string }>`select name from pragma_table_info('task')`.execute(database);
  if (columns.rows.some(({ name }) => name === "task_key")) return;
  await sql`alter table task add column task_key text`.execute(database);
};

/**
 * Execution（旧Wachaから移植したStory / Task / Claim / Comment / Change Log / Command Receipt）。
 * すべて`create ... if not exists`で、Direction側のtableには触れない。Directionへの参照（`story.outcome_ref`等）は
 * 境界をまたぐためFKを付けず、作成時のsnapshotで保持する。`project_id`は統合した既存`project.id`を使う。
 */
export const initializeWorkSchema = async (database: Kysely<WorkDatabase>): Promise<void> => {
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
