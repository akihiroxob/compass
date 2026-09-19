import type { Kysely } from "kysely";
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
};
