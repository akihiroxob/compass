import type { D1Database } from "@cloudflare/workers-types";
import { sql, type CompiledQuery, type Kysely } from "kysely";
import { attachTargetExecutions, type DirectionDatabase } from "@compass/direction";
import { asApplicationDatabase } from "../../database/contextDatabase.ts";
import { d1OutcomeExecutionQueries, outcomeExecutionsFromD1Results } from "./readD1OutcomeExecutions.ts";

/** 評価対象の全Targetと還流を同じsnapshotで読み、同じ内容のまま確定するためのSQL条件を返す。 */
export const readD1EvaluationTargets = async (database: Kysely<DirectionDatabase>, binding: D1Database, workspaceId: string, outcomeId: string) => {
  const application = asApplicationDatabase(database);
  const targetQuery = application.selectFrom("outcome_target_project as t").innerJoin("project as p", "p.id", "t.project_id")
    .select(["t.project_id", "t.created_at", "p.status as project_status", sql<number>`t.rowid`.as("target_rowid")])
    .where("t.outcome_id", "=", outcomeId).orderBy("t.created_at").orderBy(sql`t.rowid`);
  const queries = [targetQuery.compile(), ...d1OutcomeExecutionQueries(database, workspaceId, outcomeId)];
  const batch = await binding.batch(queries.map((query) => binding.prepare(query.sql).bind(...query.parameters)));
  const rows = batch[0]!.results as { project_id: string; created_at: number; project_status: "active" | "archived"; target_rowid: number }[];
  const execution = outcomeExecutionsFromD1Results(batch.slice(1));
  const targets = attachTargetExecutions(rows.map((row) => ({ outcomeId, projectId: row.project_id, createdAt: row.created_at, projectStatus: row.project_status })), execution.records).targets;
  const guards: CompiledQuery[] = [sql`SELECT 1 WHERE (SELECT COUNT(*) FROM outcome_target_project WHERE outcome_id = ${outcomeId}) = ${rows.length}`.compile(database)];
  for (const row of rows) {
    guards.push(application.selectFrom("outcome_target_project as t").innerJoin("project as p", "p.id", "t.project_id").select("t.project_id")
      .where("t.outcome_id", "=", outcomeId).where("t.project_id", "=", row.project_id).where("p.status", "=", row.project_status)
      .where(sql<boolean>`t.rowid = ${row.target_rowid}`).compile());
    const summaryQuery = database.selectFrom("outcome_execution_summary").select("outcome_id").where("workspace_id", "=", workspaceId).where("outcome_id", "=", outcomeId).where("project_id", "=", row.project_id);
    const summary = execution.summaries.find((item) => item.project_id === row.project_id);
    guards.push(summary ? summaryQuery.where("execution_cursor", "=", summary.execution_cursor).where("observed_cursor", "=", summary.observed_cursor)
      .where("state", "=", summary.state).where("stories", "=", summary.stories).where("correlation_id", "=", summary.correlation_id).compile()
      : sql`SELECT 1 WHERE NOT EXISTS ${summaryQuery}`.compile(database));
    const count = execution.evidence.filter((item) => item.project_id === row.project_id).length;
    guards.push(sql`SELECT 1 WHERE (SELECT COUNT(*) FROM outcome_execution_evidence WHERE workspace_id = ${workspaceId} AND outcome_id = ${outcomeId} AND project_id = ${row.project_id}) = ${count}`.compile(database));
  }
  return { targets, guards };
};
