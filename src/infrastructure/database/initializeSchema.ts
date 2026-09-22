import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import { ensureInitialResearchRequest } from "../repository/initialResearchRequest.ts";
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

/**
 * Research集約。すべて`create ... if not exists`なので既存DBへ再適用でき、Project / Intent / Outcomeのtableには触れない。
 * Findingは、SynthesisがIDで参照しProject内で再利用するため独立tableにする。Evidence参照・Synthesisとの関連は
 * 関連tableで表し、参照整合をDBの外部キーで守る。要素単位で検索しない文字列配列（unknowns等）はJSON列に置く。
 * Project一致は、子の行をRequest / Resultから導いた`project_id`で保存することでRepositoryが保証する。
 */
const initializeResearchSchema = async (database: Kysely<Database>): Promise<void> => {
  const projectId = (column: ColumnDefinitionBuilder) =>
    column.notNull().references("project.id").onDelete("cascade");

  await database.schema
    .createTable("research_request")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("request_key", "text", (column) => column.notNull())
    .addColumn("input_hash", "text", (column) => column.notNull())
    .addColumn("kind", "text", (column) =>
      column.notNull().check(sql`kind in ('project_watch', 'decision')`),
    )
    .addColumn("origin_intent_id", "text", (column) => column.references("intent.id").onDelete("cascade"))
    .addColumn("origin_outcome_id", "text", (column) => column.references("outcome.id").onDelete("cascade"))
    .addColumn("question", "text", (column) => column.notNull())
    .addColumn("scope", "text", (column) => column.notNull())
    .addColumn("completion_condition", "text", (column) => column.notNull())
    .addColumn("budget_total", "integer", (column) => column.notNull().check(sql`budget_total > 0`))
    .addColumn("budget_used", "integer", (column) =>
      column.notNull().defaultTo(0).check(sql`budget_used >= 0 and budget_used <= budget_total`),
    )
    .addColumn("deadline_at", "integer")
    .addColumn("status", "text", (column) =>
      column
        .notNull()
        .check(
          sql`status in ('requested', 'running', 'completed', 'insufficient', 'not_needed', 'cancelled')`,
        ),
    )
    .addColumn("stop_reason", "text")
    .addColumn("correlation_id", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addCheckConstraint(
      "research_request_decision_has_intent",
      sql`kind = 'project_watch' or origin_intent_id is not null`,
    )
    .execute();
  // 同じProject・requestKeyの再送は1件に収束させる。Initial Requestはkeyを発端Intentから決定的に作る。
  await database.schema
    .createIndex("research_request_project_key_idx")
    .unique()
    .ifNotExists()
    .on("research_request")
    .columns(["project_id", "request_key"])
    .execute();
  await database.schema
    .createIndex("research_request_origin_intent_idx")
    .ifNotExists()
    .on("research_request")
    .columns(["project_id", "origin_intent_id"])
    .execute();

  await database.schema
    .createTable("research_result")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("request_id", "text", (column) =>
      column.notNull().references("research_request.id").onDelete("cascade"),
    )
    .addColumn("sequence", "integer", (column) => column.notNull())
    .addColumn("request_key", "text", (column) => column.notNull())
    .addColumn("input_hash", "text", (column) => column.notNull())
    .addColumn("summary", "text", (column) => column.notNull())
    .addColumn("unknowns", "text", (column) => column.notNull())
    .addColumn("options", "text", (column) => column.notNull())
    .addColumn("risks", "text", (column) => column.notNull())
    .addColumn("budget_used", "integer", (column) => column.notNull().check(sql`budget_used >= 0`))
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("run_ref", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("research_result_request_sequence_idx")
    .unique()
    .ifNotExists()
    .on("research_result")
    .columns(["request_id", "sequence"])
    .execute();
  await database.schema
    .createIndex("research_result_request_key_idx")
    .unique()
    .ifNotExists()
    .on("research_result")
    .columns(["request_id", "request_key"])
    .execute();

  await database.schema
    .createTable("research_evidence_ref")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("result_id", "text", (column) =>
      column.notNull().references("research_result.id").onDelete("cascade"),
    )
    .addColumn("position", "integer", (column) => column.notNull())
    .addColumn("kind", "text", (column) =>
      column
        .notNull()
        .check(sql`kind in ('url', 'repository_file', 'issue', 'pull_request', 'ci', 'wacha_run')`),
    )
    .addColumn("uri", "text", (column) => column.notNull())
    .addColumn("retrieved_at", "integer", (column) => column.notNull())
    .addColumn("version_hash", "text")
    .execute();
  await database.schema
    .createIndex("research_evidence_ref_result_position_idx")
    .unique()
    .ifNotExists()
    .on("research_evidence_ref")
    .columns(["result_id", "position"])
    .execute();

  await database.schema
    .createTable("research_finding")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("request_id", "text", (column) =>
      column.notNull().references("research_request.id").onDelete("cascade"),
    )
    .addColumn("result_id", "text", (column) =>
      column.notNull().references("research_result.id").onDelete("cascade"),
    )
    .addColumn("position", "integer", (column) => column.notNull())
    .addColumn("statement", "text", (column) => column.notNull())
    .addColumn("confidence", "text", (column) =>
      column.notNull().check(sql`confidence in ('low', 'medium', 'high')`),
    )
    .addColumn("observed_at", "integer", (column) => column.notNull())
    .addColumn("expires_at", "integer")
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("run_ref", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("research_finding_result_position_idx")
    .unique()
    .ifNotExists()
    .on("research_finding")
    .columns(["result_id", "position"])
    .execute();
  await database.schema
    .createIndex("research_finding_project_idx")
    .ifNotExists()
    .on("research_finding")
    .column("project_id")
    .execute();

  await database.schema
    .createTable("research_finding_evidence")
    .ifNotExists()
    .addColumn("finding_id", "text", (column) =>
      column.notNull().references("research_finding.id").onDelete("cascade"),
    )
    .addColumn("evidence_ref_id", "text", (column) =>
      column.notNull().references("research_evidence_ref.id").onDelete("cascade"),
    )
    .addColumn("position", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("research_finding_evidence_pk", ["finding_id", "evidence_ref_id"])
    .execute();

  await database.schema
    .createTable("research_finding_conflict")
    .ifNotExists()
    .addColumn("finding_id", "text", (column) =>
      column.notNull().references("research_finding.id").onDelete("cascade"),
    )
    .addColumn("conflicting_finding_id", "text", (column) =>
      column.notNull().references("research_finding.id").onDelete("cascade"),
    )
    .addPrimaryKeyConstraint("research_finding_conflict_pk", ["finding_id", "conflicting_finding_id"])
    .execute();

  await database.schema
    .createTable("research_synthesis")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", projectId)
    .addColumn("request_id", "text", (column) =>
      column.notNull().references("research_request.id").onDelete("cascade"),
    )
    .addColumn("request_key", "text", (column) => column.notNull())
    .addColumn("input_hash", "text", (column) => column.notNull())
    .addColumn("version", "integer", (column) => column.notNull().check(sql`version >= 1`))
    .addColumn("supersedes_id", "text", (column) =>
      column.references("research_synthesis.id").onDelete("cascade"),
    )
    .addColumn("conclusion", "text", (column) => column.notNull())
    .addColumn("risks", "text", (column) => column.notNull())
    .addColumn("options", "text", (column) => column.notNull())
    .addColumn("unknowns", "text", (column) => column.notNull())
    .addColumn("valid_as_of", "integer", (column) => column.notNull())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("run_ref", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex("research_synthesis_request_key_idx")
    .unique()
    .ifNotExists()
    .on("research_synthesis")
    .columns(["request_id", "request_key"])
    .execute();
  // 1つのSynthesisを置き換えられるのは1件だけ。versionの系列が分岐しないことをDBで強制する。
  await sql`create unique index if not exists research_synthesis_supersedes_idx
    on research_synthesis (supersedes_id) where supersedes_id is not null`.execute(database);
  await database.schema
    .createIndex("research_synthesis_project_idx")
    .ifNotExists()
    .on("research_synthesis")
    .column("project_id")
    .execute();

  await database.schema
    .createTable("research_synthesis_finding")
    .ifNotExists()
    .addColumn("synthesis_id", "text", (column) =>
      column.notNull().references("research_synthesis.id").onDelete("cascade"),
    )
    .addColumn("finding_id", "text", (column) =>
      column.notNull().references("research_finding.id").onDelete("cascade"),
    )
    .addColumn("position", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("research_synthesis_finding_pk", ["synthesis_id", "finding_id"])
    .execute();
};

/**
 * Direction Decision導入前のDBには`outcome`にorigin_decision_id列が無い。列が無い場合だけ追加する（idempotent）。
 * FKは付けない。circular reference（direction_decision.outcome_id → outcome.id）を、outcome行を先に作ってから
 * Decision行を作る順序で解決しており、outcome側の逆参照は監査目的の平文IDで十分なため。
 */
const addOutcomeOriginDecisionColumn = async (database: Kysely<Database>): Promise<void> => {
  const columns = await sql<{ name: string }>`select name from pragma_table_info('outcome')`.execute(database);
  if (columns.rows.some(({ name }) => name === "origin_decision_id")) return;
  await sql`alter table outcome add column origin_decision_id text`.execute(database);
};

/**
 * Direction Decision（Task 27）。作成後は変更しない追記専用tableで、判断時点のIntent Brief snapshotをJSONで保持する。
 * `outcome_id`はnext_outcomeのときだけ設定し、outcome.idへのFKで整合を守る。使用したSynthesis/Findingは関連tableで表す。
 */
const initializeDirectionDecisionSchema = async (database: Kysely<Database>): Promise<void> => {
  await database.schema
    .createTable("direction_decision")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("project_id", "text", (column) => column.notNull().references("project.id").onDelete("cascade"))
    .addColumn("intent_id", "text", (column) => column.notNull().references("intent.id").onDelete("cascade"))
    .addColumn("outcome_id", "text", (column) => column.references("outcome.id").onDelete("cascade"))
    .addColumn("type", "text", (column) =>
      column
        .notNull()
        .check(
          sql`type in ('next_outcome', 'additional_research', 'intent_complete', 'intent_abandon', 'policy_proposal', 'adr_candidate')`,
        ),
    )
    .addColumn("judgment", "text", (column) => column.notNull())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("options", "text", (column) => column.notNull())
    .addColumn("intent_brief_snapshot", "text", (column) => column.notNull())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("run_ref", "text", (column) => column.notNull())
    .addColumn("request_key", "text", (column) => column.notNull())
    .addColumn("input_hash", "text", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addCheckConstraint("direction_decision_outcome_requires_next_outcome", sql`(type = 'next_outcome') = (outcome_id is not null)`)
    .execute();
  await database.schema
    .createIndex("direction_decision_project_key_idx")
    .unique()
    .ifNotExists()
    .on("direction_decision")
    .columns(["project_id", "request_key"])
    .execute();
  await database.schema
    .createIndex("direction_decision_intent_idx")
    .ifNotExists()
    .on("direction_decision")
    .columns(["project_id", "intent_id"])
    .execute();

  await database.schema
    .createTable("direction_decision_synthesis")
    .ifNotExists()
    .addColumn("decision_id", "text", (column) =>
      column.notNull().references("direction_decision.id").onDelete("cascade"),
    )
    .addColumn("synthesis_id", "text", (column) =>
      column.notNull().references("research_synthesis.id").onDelete("cascade"),
    )
    .addColumn("version", "integer", (column) => column.notNull())
    .addColumn("position", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("direction_decision_synthesis_pk", ["decision_id", "synthesis_id"])
    .execute();

  await database.schema
    .createTable("direction_decision_finding")
    .ifNotExists()
    .addColumn("decision_id", "text", (column) =>
      column.notNull().references("direction_decision.id").onDelete("cascade"),
    )
    .addColumn("finding_id", "text", (column) =>
      column.notNull().references("research_finding.id").onDelete("cascade"),
    )
    .addColumn("position", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("direction_decision_finding_pk", ["decision_id", "finding_id"])
    .execute();
};

/**
 * Initial Research Request導入前に作成されたActive Intentへ、Initial Requestとイベントを補う。
 * keyがIntentから決定的で、既にあれば何もしないため、起動のたびに実行しても重複しない（Requestを取り消した後も再作成しない）。
 * archivedのProjectと、Active以外のIntentは対象にしない。導入後に作成したIntentは作成時点で保存済みのため対象外になる。
 */
const backfillInitialResearchRequests = async (database: Kysely<Database>): Promise<void> => {
  await database.transaction().execute(async (transaction) => {
    const intents = await transaction
      .selectFrom("intent")
      .innerJoin("project", "project.id", "intent.project_id")
      .selectAll("intent")
      .where("intent.status", "=", "active")
      .where("project.status", "=", "active")
      .orderBy("intent.created_at", "asc")
      .execute();
    for (const intent of intents) await ensureInitialResearchRequest(transaction, intent, Date.now());
  });
};

/**
 * Runtime向けの確定イベント。同じRequestに対する同じ種類のイベントは1件に収束させ、再送・復旧・再初期化で重複させない。
 * `sequence`は`autoincrement`で、削除後も番号を再利用しない（Runtimeのcursorが巻き戻らない）。
 */
const initializeRuntimeEventSchema = async (database: Kysely<Database>): Promise<void> => {
  await database.schema
    .createTable("runtime_event")
    .ifNotExists()
    .addColumn("sequence", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("id", "text", (column) => column.notNull().unique())
    .addColumn("event_version", "integer", (column) => column.notNull())
    .addColumn("event_type", "text", (column) =>
      column.notNull().check(sql`event_type in ('research_requested', 'research_completed')`),
    )
    .addColumn("project_id", "text", (column) =>
      column.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("intent_id", "text", (column) => column.references("intent.id").onDelete("cascade"))
    .addColumn("research_request_id", "text", (column) =>
      column.notNull().references("research_request.id").onDelete("cascade"),
    )
    .addColumn("correlation_id", "text", (column) => column.notNull())
    .addColumn("conclusion", "text", (column) =>
      column.check(sql`conclusion is null or conclusion in ('completed', 'insufficient', 'not_needed')`),
    )
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addCheckConstraint(
      "runtime_event_conclusion_matches_type",
      sql`(event_type = 'research_completed') = (conclusion is not null)`,
    )
    .execute();
  await database.schema
    .createIndex("runtime_event_request_type_idx")
    .unique()
    .ifNotExists()
    .on("runtime_event")
    .columns(["research_request_id", "event_type"])
    .execute();
  await database.schema
    .createIndex("runtime_event_project_sequence_idx")
    .ifNotExists()
    .on("runtime_event")
    .columns(["project_id", "sequence"])
    .execute();
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

  await initializeResearchSchema(database);
  await initializeDirectionDecisionSchema(database);
  await addOutcomeOriginDecisionColumn(database);
  await initializeRuntimeEventSchema(database);
  await backfillInitialResearchRequests(database);
};
