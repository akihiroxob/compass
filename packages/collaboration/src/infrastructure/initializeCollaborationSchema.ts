import { sql, type Kysely } from "kysely";
import type { CollaborationDatabase } from "./schema.ts";

/**
 * Collaborationのtable。`create ... if not exists`だけで、他Contextのtableには触れない。旧schemaの変換は行わない（開発DBを再作成する）。
 * 相談は所属Workspace・Projectを両方持ち、`project_id`は既存`project.id`を参照する（Project削除時は一緒に消える）。
 * 状態・判断の由来・記録主体の種類はDBでも制約し、結論は相談につき1件、発言の順序は相談内で一意にする。
 */
export const initializeCollaborationSchema = async (database: Kysely<CollaborationDatabase>): Promise<void> => {
  await database.schema
    .createTable("consultation")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("workspace_id", "text", (column) => column.notNull().references("workspace.id"))
    .addColumn("project_id", "text", (column) => column.notNull().references("project.id").onDelete("cascade"))
    .addColumn("title", "text", (column) => column.notNull())
    .addColumn("question", "text", (column) => column.notNull())
    .addColumn("blocking_reason", "text", (column) => column.notNull())
    .addColumn("options", "text", (column) => column.notNull().defaultTo("[]"))
    .addColumn("recommendation", "text", (column) => column.notNull())
    .addColumn("impact", "text", (column) => column.notNull())
    .addColumn("refs", "text", (column) => column.notNull().defaultTo("[]"))
    .addColumn("status", "text", (column) =>
      column.notNull().check(sql`status in ('waiting_human', 'waiting_agent', 'resolved', 'canceled')`),
    )
    .addColumn("revision", "integer", (column) => column.notNull().check(sql`revision >= 1`))
    .addColumn("supersedes_consultation_id", "text", (column) => column.references("consultation.id"))
    .addColumn("created_by_kind", "text", (column) => column.notNull().check(sql`created_by_kind in ('human', 'agent')`))
    .addColumn("created_by_principal_id", "text", (column) => column.notNull())
    .addColumn("created_by_role", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("cancel_reason", "text")
    .addColumn("canceled_by_kind", "text", (column) => column.check(sql`canceled_by_kind in ('human', 'agent')`))
    .addColumn("canceled_by_principal_id", "text")
    .addColumn("canceled_by_role", "text")
    .addColumn("canceled_at", "integer")
    .addCheckConstraint(
      "consultation_cancel_check",
      sql`(status = 'canceled') = (cancel_reason is not null and canceled_by_kind is not null and canceled_by_principal_id is not null and canceled_at is not null)`,
    )
    .execute();
  await database.schema
    .createIndex("consultation_project_updated_idx")
    .ifNotExists()
    .on("consultation")
    .columns(["project_id", "status", "updated_at"])
    .execute();

  await database.schema
    .createTable("consultation_message")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("consultation_id", "text", (column) => column.notNull().references("consultation.id").onDelete("cascade"))
    .addColumn("sequence", "integer", (column) => column.notNull().check(sql`sequence >= 1`))
    .addColumn("author_kind", "text", (column) => column.notNull().check(sql`author_kind in ('human', 'agent')`))
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("body", "text", (column) => column.notNull().check(sql`length(trim(body)) > 0`))
    .addColumn("corrects_message_id", "text", (column) => column.references("consultation_message.id"))
    .addColumn("revision", "integer", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addUniqueConstraint("consultation_message_sequence_unique", ["consultation_id", "sequence"])
    .execute();

  await database.schema
    .createTable("consultation_resolution")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("consultation_id", "text", (column) => column.notNull().unique().references("consultation.id").onDelete("cascade"))
    .addColumn("source", "text", (column) => column.notNull().check(sql`source in ('human_decision', 'agent_summary')`))
    .addColumn("conclusion", "text", (column) => column.notNull())
    .addColumn("rationale", "text", (column) => column.notNull())
    .addColumn("applicability", "text")
    .addColumn("selected_option", "integer")
    .addColumn("basis_message_ids", "text", (column) => column.notNull().defaultTo("[]"))
    .addColumn("basis_revision", "integer", (column) => column.notNull())
    .addColumn("recorded_by_kind", "text", (column) => column.notNull().check(sql`recorded_by_kind in ('human', 'agent')`))
    .addColumn("recorded_by_principal_id", "text", (column) => column.notNull())
    .addColumn("recorded_by_role", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    // 判断の由来と記録主体を一致させる。Agentの記録をHumanの明示決定として保存できない。
    .addCheckConstraint(
      "consultation_resolution_source_check",
      sql`(source = 'human_decision' and recorded_by_kind = 'human') or (source = 'agent_summary' and recorded_by_kind = 'agent')`,
    )
    .execute();

  await database.schema
    .createTable("consultation_lease")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("consultation_id", "text", (column) => column.notNull().references("consultation.id").onDelete("cascade"))
    .addColumn("input_revision", "integer", (column) => column.notNull())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("acquired_at", "integer", (column) => column.notNull())
    .addColumn("expires_at", "integer", (column) => column.notNull())
    .addColumn("released_at", "integer")
    .execute();
  await database.schema
    .createIndex("consultation_lease_consultation_idx")
    .ifNotExists()
    .on("consultation_lease")
    .columns(["consultation_id", "input_revision"])
    .execute();

  await database.schema
    .createTable("consultation_command_receipt")
    .ifNotExists()
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("operation", "text", (column) => column.notNull())
    .addColumn("request_id", "text", (column) => column.notNull())
    .addColumn("input_hash", "text", (column) => column.notNull())
    .addColumn("result_json", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("consultation_command_receipt_pk", ["principal_id", "operation", "request_id"])
    .execute();
};
