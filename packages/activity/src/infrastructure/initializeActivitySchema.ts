import { sql, type Kysely } from "kysely";
import type { ActivityDatabase } from "./schema.ts";

/**
 * Activityのtable。`create ... if not exists`だけで、他Contextのtableには触れない。追記専用で、更新・削除の経路は持たない。
 * systemは両IDなし、workspaceはworkspace_idのみ、projectは両ID必須をDBでも強制する。
 * 旧Activity schemaの変換は行わない。schema変更時は開発DBを再作成する。
 * `project_id`は統合した既存`project.id`を参照する（Project削除時は一緒に消える）。
 */
export const initializeActivitySchema = async (database: Kysely<ActivityDatabase>): Promise<void> => {
  await database.schema
    .createTable("activity")
    .ifNotExists()
    .addColumn("cursor", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("id", "text", (column) => column.notNull().unique())
    .addColumn("scope", "text", (column) => column.notNull().check(sql`scope in ('project', 'workspace', 'system')`))
    .addColumn("workspace_id", "text", (column) => column.references("workspace.id"))
    .addColumn("project_id", "text", (column) => column.references("project.id").onDelete("cascade"))
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("summary", "text", (column) => column.notNull().check(sql`length(trim(summary)) > 0`))
    .addColumn("body", "text")
    .addColumn("refs", "text", (column) => column.notNull().defaultTo("[]"))
    .addColumn("corrects_activity_id", "text", (column) => column.references("activity.id"))
    .addColumn("source", "text", (column) => column.notNull().check(sql`source in ('recorded', 'canonical')`))
    .addColumn("dedupe_key", "text", (column) => column.notNull().unique())
    .addColumn("input_hash", "text")
    .addColumn("occurred_at", "integer", (column) => column.notNull())
    .addColumn("recorded_at", "integer", (column) => column.notNull())
    .addCheckConstraint(
      "activity_scope_ids_check",
      sql`(scope = 'project' and workspace_id is not null and project_id is not null)
        or (scope = 'workspace' and workspace_id is not null and project_id is null)
        or (scope = 'system' and workspace_id is null and project_id is null)`,
    )
    .execute();
  await database.schema
    .createIndex("activity_project_cursor_idx")
    .ifNotExists()
    .on("activity")
    .columns(["project_id", "cursor"])
    .execute();
  await database.schema
    .createIndex("activity_workspace_cursor_idx")
    .ifNotExists()
    .on("activity")
    .columns(["scope", "workspace_id", "cursor"])
    .execute();
  await database.schema
    .createIndex("activity_corrects_idx")
    .ifNotExists()
    .on("activity")
    .column("corrects_activity_id")
    .execute();
};
