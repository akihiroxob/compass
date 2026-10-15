import { sql, type Kysely } from "kysely";
import type { OrganizationDatabase } from "./schema.ts";

/**
 * Project・Repository・Resourceのtable。Projectは必ず1つのWorkspaceに属し（`workspace_id`はNOT NULLのFK）、
 * 戦略値（Mission等）は持たない。archived_at / archive_reasonとstatusの整合はRepositoryが保証する。
 */
const initializeProjectSchema = async (database: Kysely<OrganizationDatabase>): Promise<void> => {
  await database.schema
    .createTable("project")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("workspace_id", "text", (column) => column.notNull().references("workspace.id"))
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("active").check(sql`status in ('active', 'archived')`),
    )
    .addColumn("archived_at", "integer")
    .addColumn("archive_reason", "text")
    .execute();

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

/**
 * Organizationが所有するtableの新規DB定義。`create ... if not exists`で同じschemaのDBへ再適用できる。旧定義のDBは再作成する。
 * 他Contextのtableが`project`を参照するため、serverの`initializeSchema`が最初に呼ぶ。
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
  await initializeProjectSchema(database);
  // 他ContextがProjectの所属Workspaceを複合FKで参照するための親キー。
  await database.schema.createIndex("project_id_workspace_idx").ifNotExists().unique()
    .on("project").columns(["id", "workspace_id"]).execute();
};
