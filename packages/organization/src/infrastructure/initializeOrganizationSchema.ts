import { sql, type Kysely } from "kysely";
import type { OrganizationDatabase } from "./schema.ts";

/**
 * 追加のtableだけを`create ... if not exists`で作る。既存DBへ再適用でき、Direction等の既存tableには触れない。
 * archived_at / archive_reasonとstatusの整合は`project`と同じくRepositoryが保証する。
 */
export const initializeOrganizationSchema = async (database: Kysely<OrganizationDatabase>): Promise<void> => {
  await database.schema
    .createTable("workspace")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
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

  for (const table of ["workspace_principle", "workspace_constraint"] as const) {
    await database.schema
      .createTable(table)
      .ifNotExists()
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspace.id").onDelete("cascade"),
      )
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("sort_order", "integer", (column) => column.notNull())
      .execute();
  }
};
