import type { Kysely, Selectable } from "kysely";
import { maximumEvidencePerOutcomeProject } from "../domain/OutcomeExecution.ts";
import type { RecordOutcomeExecutionInput } from "../domain/OutcomeExecutionRepository.ts";
import type { DirectionDatabase, OutcomeExecutionSummaryTable, OutcomeExecutionEvidenceTable } from "./schema.ts";
import { toSummary, toEvidence } from "./outcomeTargetExecutionRecord.ts";

/** cursorの単調性・Evidenceの重複／上限と、返す保存snapshotをSQLite／D1で共有する。 */
export const planOutcomeExecutionRecord = (database: Kysely<DirectionDatabase>, workspaceId: string, projectId: string,
  input: RecordOutcomeExecutionInput, existing: Selectable<OutcomeExecutionSummaryTable> | undefined,
  stored: Selectable<OutcomeExecutionEvidenceTable>[]) => {
  const fresh: RecordOutcomeExecutionInput["evidence"][number][] = [];
  for (const item of input.evidence) {
    const duplicate = fresh.some((other) => other.kind === item.kind && other.uri === item.uri && other.versionHash === item.versionHash)
      || stored.some((other) => other.kind === item.kind && other.uri === item.uri && (other.version_hash ?? "") === (item.versionHash ?? ""));
    if (!duplicate) fresh.push(item);
  }
  if (stored.length + fresh.length > maximumEvidencePerOutcomeProject) return { kind: "evidence_limit_exceeded" as const, limit: maximumEvidencePerOutcomeProject };
  const observed = Math.max(existing?.observed_cursor ?? 0, input.changeCursor);
  const summaryChanged = !existing || input.executionCursor > existing.execution_cursor;
  const row: Selectable<OutcomeExecutionSummaryTable> = summaryChanged ? {
    workspace_id: workspaceId, project_id: projectId, outcome_id: input.outcomeId, correlation_id: existing?.correlation_id ?? input.correlationId,
    state: input.state, stories: JSON.stringify(input.stories), execution_cursor: input.executionCursor,
    observed_cursor: observed, principal_id: input.principalId, updated_at: input.at,
  } : { ...existing, observed_cursor: observed };
  const scope = database.updateTable("outcome_execution_summary").where("workspace_id", "=", workspaceId).where("project_id", "=", projectId).where("outcome_id", "=", input.outcomeId);
  const mutations = !existing ? [database.insertInto("outcome_execution_summary").values(row).compile()]
    : summaryChanged ? [scope.set({ state: row.state, stories: row.stories, execution_cursor: row.execution_cursor,
      observed_cursor: row.observed_cursor, principal_id: row.principal_id, updated_at: row.updated_at }).compile()]
    : observed > existing.observed_cursor ? [scope.set({ observed_cursor: observed }).compile()] : [];
  const added = fresh.map((item) => ({ id: crypto.randomUUID(), workspace_id: workspaceId, project_id: projectId, outcome_id: input.outcomeId,
    kind: item.kind, uri: item.uri, version_hash: item.versionHash, observed_at: item.observedAt, source_change_cursor: input.changeCursor,
    principal_id: input.principalId, created_at: input.at }));
  mutations.push(...added.map((item) => database.insertInto("outcome_execution_evidence").values(item).compile()));
  // 同時刻では既存のrowid順を維持し、新規分は挿入順で後ろへ置く（stable sort）。
  const evidence = [...stored, ...added].sort((a, b) => a.observed_at - b.observed_at || a.created_at - b.created_at);
  return { kind: "planned" as const, mutations, result: { kind: "recorded" as const, record: { summary: toSummary(row), evidence: evidence.map(toEvidence) },
    summaryChanged, staleInput: existing !== undefined && input.changeCursor < existing.observed_cursor, evidenceAdded: fresh.length } };
};
