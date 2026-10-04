import { sql, type Kysely } from "kysely";
import type { ActivityDatabase } from "./schema.ts";

/**
 * Activityのtable。`create ... if not exists`だけで、他Contextのtableには触れない。追記専用で、更新・削除の経路は持たない。
 * `scope=project`は`project_id`必須、`scope=system`は`project_id`なしをDBでも強制する。
 * `project_id`は統合した既存`project.id`を参照する（Project削除時は一緒に消える）。
 */
export const initializeActivitySchema = async (database: Kysely<ActivityDatabase>): Promise<void> => {
  await database.schema
    .createTable("activity")
    .ifNotExists()
    .addColumn("cursor", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("id", "text", (column) => column.notNull().unique())
    .addColumn("scope", "text", (column) => column.notNull().check(sql`scope in ('project', 'system')`))
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
      "activity_scope_project_check",
      sql`(scope = 'project' and project_id is not null) or (scope = 'system' and project_id is null)`,
    )
    .execute();
  await database.schema
    .createIndex("activity_project_cursor_idx")
    .ifNotExists()
    .on("activity")
    .columns(["project_id", "cursor"])
    .execute();
  await database.schema
    .createIndex("activity_corrects_idx")
    .ifNotExists()
    .on("activity")
    .column("corrects_activity_id")
    .execute();
};
