import { sql, type Kysely } from "kysely";
import { migrateProjectStrategyToWorkspaces } from "./migrateProjectStrategy.ts";
import type { OrganizationDatabase } from "./schema.ts";

/** 既存DBの`project`に列が無い場合だけ追加する（idempotent）。既存の列・行は書き換えない。 */
const addProjectColumnIfMissing = async (
  database: Kysely<OrganizationDatabase>,
  name: string,
  definitions: ReturnType<typeof sql>[],
): Promise<void> => {
  const columns = await sql<{ name: string }>`select name from pragma_table_info('project')`.execute(database);
  if (columns.rows.some((column) => column.name === name)) return;
  for (const definition of definitions) await sql`alter table project add column ${definition}`.execute(database);
};

/**
 * Project・Repository・Resourceのtable（Directionから移した所有）。作成済みDBへは`create table if not exists`が効かないため、
 * 後から加えた列（archive列・`workspace_id`・`strategy_migrated_at`）は列が無い場合だけ追加する。`default 'active'`で既存の全行が
 * activeになる。SQLiteの`ADD COLUMN`はtable制約を足せないため、archived_at / archive_reasonとstatusの整合はRepositoryが保証する。
 */
const initializeProjectSchema = async (database: Kysely<OrganizationDatabase>): Promise<void> => {
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
  await addProjectColumnIfMissing(database, "status", [
    sql`status text not null default 'active' check (status in ('active', 'archived'))`,
    sql`archived_at integer`,
    sql`archive_reason text`,
  ]);
  await addProjectColumnIfMissing(database, "workspace_id", [sql`workspace_id text references workspace(id)`]);
  await addProjectColumnIfMissing(database, "strategy_migrated_at", [sql`strategy_migrated_at integer`]);

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

/**
 * Organizationが所有するtableの作成と、既存Projectの戦略値のWorkspaceへの移行。`create ... if not exists`と列の有無の確認で
 * 既存DBへ再適用できる。他Contextのtableが`project`を参照するため、serverの`initializeSchema`が最初に呼ぶ。
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
  await migrateProjectStrategyToWorkspaces(database);
};
