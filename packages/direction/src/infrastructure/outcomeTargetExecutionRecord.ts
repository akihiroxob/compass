import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type { OutcomeExecutionEvidence, OutcomeExecutionRecord, OutcomeExecutionSummary } from "../domain/OutcomeExecution.ts";
import type { OutcomeTargetProject, OutcomeTargetProjectView } from "../domain/OutcomeTargetProject.ts";
import type {
  DirectionDatabase,
  OutcomeExecutionEvidenceTable,
  OutcomeExecutionSummaryTable,
  OutcomeTargetProjectTable,
} from "./schema.ts";
import type { DirectionProjectReaders } from "./directionProjectReaders.ts";

type Executor = Kysely<DirectionDatabase> | Transaction<DirectionDatabase>;

export const toTarget = (row: Selectable<OutcomeTargetProjectTable>): OutcomeTargetProject => ({
  outcomeId: row.outcome_id,
  projectId: row.project_id,
  createdAt: row.created_at,
});

/** Projectの現在の状態（Organizationが所有）を、Targetごとに読まず1回で添える。 */
export const toTargetViews = async (
  executor: Executor,
  projects: DirectionProjectReaders,
  rows: Selectable<OutcomeTargetProjectTable>[],
): Promise<OutcomeTargetProjectView[]> => {
  const archived = await projects(executor).findArchivedIds([...new Set(rows.map((row) => row.project_id))]);
  return rows.map((row) => ({ ...toTarget(row), projectStatus: archived.has(row.project_id) ? "archived" : "active" }));
};

/** OutcomeのTargetを設定順で読む。Outcomeの存在は呼出側が確認する。 */
export const readOutcomeTargetViews = async (
  executor: Executor,
  projects: DirectionProjectReaders,
  outcomeId: string,
): Promise<OutcomeTargetProjectView[]> => {
  const rows = await executor
    .selectFrom("outcome_target_project")
    .selectAll()
    .where("outcome_id", "=", outcomeId)
    .orderBy("created_at")
    .orderBy(sql`rowid`)
    .execute();
  return toTargetViews(executor, projects, rows);
};

export const toSummary = (row: Selectable<OutcomeExecutionSummaryTable>): OutcomeExecutionSummary => ({
  workspaceId: row.workspace_id,
  projectId: row.project_id,
  outcomeId: row.outcome_id,
  correlationId: row.correlation_id,
  state: row.state,
  stories: JSON.parse(row.stories) as OutcomeExecutionSummary["stories"],
  executionCursor: row.execution_cursor,
  observedCursor: row.observed_cursor,
  principalId: row.principal_id,
  updatedAt: row.updated_at,
});

export const toEvidence = (row: Selectable<OutcomeExecutionEvidenceTable>): OutcomeExecutionEvidence => ({
  id: row.id,
  workspaceId: row.workspace_id,
  projectId: row.project_id,
  outcomeId: row.outcome_id,
  kind: row.kind,
  uri: row.uri,
  versionHash: row.version_hash,
  observedAt: row.observed_at,
  sourceChangeCursor: row.source_change_cursor,
  principalId: row.principal_id,
  createdAt: row.created_at,
});

/** Outcomeへ還流したExecutionを、発生元Project ID順に読む。EvidenceはProjectごとに分け、別ProjectのEvidenceを混ぜない。 */
export const readOutcomeExecutionRecords = async (
  executor: Executor,
  workspaceId: string,
  outcomeId: string,
): Promise<OutcomeExecutionRecord[]> => {
  const summaries = await executor.selectFrom("outcome_execution_summary").selectAll()
    .where("workspace_id", "=", workspaceId).where("outcome_id", "=", outcomeId).orderBy("project_id").execute();
  if (summaries.length === 0) return [];
  const evidence = await executor.selectFrom("outcome_execution_evidence").selectAll()
    .where("workspace_id", "=", workspaceId).where("outcome_id", "=", outcomeId)
    .orderBy("observed_at", "asc").orderBy("created_at", "asc").orderBy(sql`rowid`, "asc").execute();
  return summaries.map((summary) => ({
    summary: toSummary(summary),
    evidence: evidence.filter((row) => row.project_id === summary.project_id).map(toEvidence),
  }));
};
