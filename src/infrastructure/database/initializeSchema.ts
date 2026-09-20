import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

/**
 * Project archive導入前のDBには`project`のarchive列が無い。`create table if not exists`では追加されないため、
 * 列が無い場合だけ追加する（idempotent）。`default 'active'`で既存の全行がactiveになり、既存行・子tableは書き換えない。
 * SQLiteの`ADD COLUMN`はtable制約を足せないため、archived_at / archive_reasonとstatusの整合はRepositoryが保証する。
 */
const addProjectArchiveColumns = async (database: Kysely<Database>): Promise<void> => {
  const columns = await sql<{ name: string }>`select name from pragma_table_info('project')`.execute(database);
  if (columns.rows.some(({ name }) => name === "status")) return;
  await sql`alter table project add column status text not null default 'active' check (status in ('active', 'archived'))`.execute(database);
  await sql`alter table project add column archived_at integer`.execute(database);
  await sql`alter table project add column archive_reason text`.execute(database);
};

export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await database.schema
    .createTable("project")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("mission", "text", (column) => column.notNull())
    .addColumn("vision", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("active").check(sql`status in ('active', 'archived')`),
    )
    .addColumn("archived_at", "integer")
    .addColumn("archive_reason", "text")
    .execute();
  await addProjectArchiveColumns(database);

  for (const table of ["project_principle", "project_constraint"] as const) {
    await database.schema
      .createTable(table)
      .ifNotExists()
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("project_id", "text", (column) =>
        column.notNull().references("project.id").onDelete("cascade"),
      )
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("sort_order", "integer", (column) => column.notNull())
      .execute();
  }

  await database.schema
    .createTable("project_repository_link")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) =>
      column.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("url", "text", (column) => column.notNull())
    .addColumn("sort_order", "integer", (column) => column.notNull())
    .execute();

  await database.schema
    .createTable("project_resource")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) =>
      column.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("url", "text", (column) => column.notNull())
    .addColumn("kind", "text")
    .addColumn("sort_order", "integer", (column) => column.notNull())
    .execute();

  await database.schema
    .createTable("intent")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) =>
      column.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (column) => column.notNull())
    .addColumn("desired_state", "text", (column) => column.notNull())
    .addColumn("completion_definition", "text")
    .addColumn("status", "text", (column) =>
      column.notNull().check(sql`status in ('active', 'achieved', 'abandoned')`),
    )
    .addColumn("abandoned_reason", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .execute();

  // Active Intentは Projectにつき最大1件。アプリケーション層の検査に加えてDBでも強制する。
  await sql`create unique index if not exists intent_one_active_per_project
    on intent (project_id) where status = 'active'`.execute(database);
  await database.schema
    .createIndex("intent_project_id_idx")
    .ifNotExists()
    .on("intent")
    .column("project_id")
    .execute();

  // statusのcheckは、後続で公開する状態値（evaluating / achieved / not_achieved）も含める。
  // SQLiteはcheck制約の変更にtable再作成が必要なため、状態の公開時にDB変更を不要にする。
  await database.schema
    .createTable("outcome")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) =>
      column.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("intent_id", "text", (column) =>
      column.notNull().references("intent.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (column) => column.notNull())
    .addColumn("description", "text", (column) => column.notNull())
    .addColumn("hypothesis", "text")
    .addColumn("rationale", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column
        .notNull()
        .check(sql`status in ('active', 'evaluating', 'achieved', 'not_achieved', 'cancelled')`),
    )
    .addColumn("cancel_reason", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("outcome_intent_id_created_at_idx")
    .ifNotExists()
    .on("outcome")
    .columns(["intent_id", "created_at"])
    .execute();

  await database.schema
    .createTable("success_criterion")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("outcome_id", "text", (column) =>
      column.notNull().references("outcome.id").onDelete("cascade"),
    )
    .addColumn("position", "integer", (column) => column.notNull())
    .addColumn("description", "text", (column) => column.notNull())
    .addColumn("measurement", "text", (column) => column.notNull())
    .addColumn("target", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("success_criterion_outcome_id_position_idx")
    .unique()
    .ifNotExists()
    .on("success_criterion")
    .columns(["outcome_id", "position"])
    .execute();

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
