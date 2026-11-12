import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable } from "kysely";
import { outcomeExecutionSummaryFromRow, outcomeExecutionEvidenceFromRow, type DirectionDatabase,
  type OutcomeExecutionSummaryTable, type OutcomeExecutionEvidenceTable } from "@compass/direction";

export const d1OutcomeExecutionQueries = (database: Kysely<DirectionDatabase>, workspaceId: string, outcomeId: string, projectId?: string) => {
  let summaries = database.selectFrom("outcome_execution_summary").selectAll().where("workspace_id", "=", workspaceId).where("outcome_id", "=", outcomeId);
  let evidence = database.selectFrom("outcome_execution_evidence").selectAll().where("workspace_id", "=", workspaceId).where("outcome_id", "=", outcomeId);
  if (projectId !== undefined) { summaries = summaries.where("project_id", "=", projectId); evidence = evidence.where("project_id", "=", projectId); }
  return [summaries.orderBy("project_id").compile(), evidence.orderBy("observed_at").orderBy("created_at").orderBy(sql`rowid`).compile()];
};

export const outcomeExecutionsFromD1Results = (batch: D1Result[]) => {
  const summaries = batch[0]!.results as Selectable<OutcomeExecutionSummaryTable>[];
  const evidence = batch[1]!.results as Selectable<OutcomeExecutionEvidenceTable>[];
  return { summaries, evidence, records: summaries.map((row) => ({ summary: outcomeExecutionSummaryFromRow(row),
    evidence: evidence.filter((item) => item.project_id === row.project_id).map(outcomeExecutionEvidenceFromRow) })) };
};

export const readD1OutcomeExecutions = async (database: Kysely<DirectionDatabase>, binding: D1Database, workspaceId: string, outcomeId: string, projectId?: string) =>
  outcomeExecutionsFromD1Results(await binding.batch(d1OutcomeExecutionQueries(database, workspaceId, outcomeId, projectId)
    .map((query) => binding.prepare(query.sql).bind(...query.parameters))));
