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
};
