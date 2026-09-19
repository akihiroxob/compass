import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

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
    .execute();

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
};
