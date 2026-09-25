import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import {
  maximumEvidencePerOutcome,
  type OutcomeExecutionEvidence,
  type OutcomeExecutionRecord,
  type OutcomeExecutionSummary,
} from "../../domain/model/OutcomeExecution.ts";
import type {
  OutcomeExecutionRepository,
  RecordOutcomeExecutionInput,
  RecordOutcomeExecutionResult,
} from "../../domain/repository/OutcomeExecutionRepository.ts";
import type {
  Database,
  OutcomeExecutionEvidenceTable,
  OutcomeExecutionSummaryTable,
} from "../database/schema.ts";
import { isProjectArchived } from "./isProjectArchived.ts";

const toSummary = (row: Selectable<OutcomeExecutionSummaryTable>): OutcomeExecutionSummary => ({
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

const toEvidence = (row: Selectable<OutcomeExecutionEvidenceTable>): OutcomeExecutionEvidence => ({
  id: row.id,
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

const sameEvidence = (
  left: RecordOutcomeExecutionInput["evidence"][number],
  right: RecordOutcomeExecutionInput["evidence"][number],
) => left.kind === right.kind && left.uri === right.uri && left.versionHash === right.versionHash;

export class SQLiteOutcomeExecutionRepository implements OutcomeExecutionRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async record(projectId: string, input: RecordOutcomeExecutionInput): Promise<RecordOutcomeExecutionResult> {
    return this.database.transaction().execute(async (transaction): Promise<RecordOutcomeExecutionResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };

      const existing = await transaction
        .selectFrom("outcome_execution_summary")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("outcome_id", "=", input.outcomeId)
        .executeTakeFirst();
      const previousObserved = existing?.observed_cursor ?? 0;
      const observedCursor = Math.max(previousObserved, input.changeCursor);
      // 保存済みの報告より古いcursorの通知（順序逆転）。要約は巻き戻さず、Evidenceだけ重複なく取り込む。
      const staleInput = existing !== undefined && input.changeCursor < previousObserved;

      // Evidenceは書込の前に、既存との重複（同じOutcome・種別・URI・version）と上限を確認する。
      const fresh: RecordOutcomeExecutionInput["evidence"][number][] = [];
      for (const item of input.evidence) {
        const duplicate =
          fresh.some((other) => sameEvidence(other, item)) ||
          (await transaction
            .selectFrom("outcome_execution_evidence")
            .select("id")
            .where("outcome_id", "=", input.outcomeId)
            .where("kind", "=", item.kind)
            .where("uri", "=", item.uri)
            .where(sql<string>`ifnull(version_hash, '')`, "=", item.versionHash ?? "")
            .executeTakeFirst());
        if (!duplicate) fresh.push(item);
      }
      const stored = await transaction
        .selectFrom("outcome_execution_evidence")
        .select(({ fn }) => fn.countAll<number>().as("total"))
        .where("outcome_id", "=", input.outcomeId)
        .executeTakeFirstOrThrow();
      if (Number(stored.total) + fresh.length > maximumEvidencePerOutcome) {
        return { kind: "evidence_limit_exceeded", limit: maximumEvidencePerOutcome };
      }

      let summaryChanged = false;
      if (!existing) {
        await transaction
          .insertInto("outcome_execution_summary")
          .values({
            project_id: projectId,
            outcome_id: input.outcomeId,
            correlation_id: input.correlationId,
            state: input.state,
            stories: JSON.stringify(input.stories),
            execution_cursor: input.executionCursor,
            observed_cursor: observedCursor,
            principal_id: input.principalId,
            updated_at: input.at,
          })
          .execute();
        summaryChanged = true;
      } else if (input.executionCursor > existing.execution_cursor) {
        await transaction
          .updateTable("outcome_execution_summary")
          .set({
            state: input.state,
            stories: JSON.stringify(input.stories),
            execution_cursor: input.executionCursor,
            observed_cursor: observedCursor,
            principal_id: input.principalId,
            updated_at: input.at,
          })
          .where("outcome_id", "=", input.outcomeId)
          .execute();
        summaryChanged = true;
      } else if (observedCursor > previousObserved) {
        await transaction
          .updateTable("outcome_execution_summary")
          .set({ observed_cursor: observedCursor })
          .where("outcome_id", "=", input.outcomeId)
          .execute();
      }

      for (const item of fresh) {
        await transaction
          .insertInto("outcome_execution_evidence")
          .values({
            id: crypto.randomUUID(),
            project_id: projectId,
            outcome_id: input.outcomeId,
            kind: item.kind,
            uri: item.uri,
            version_hash: item.versionHash,
            observed_at: item.observedAt,
            source_change_cursor: input.changeCursor,
            principal_id: input.principalId,
            created_at: input.at,
          })
          .execute();
      }

      const record = await this.load(transaction, projectId, input.outcomeId);
      if (record === null) throw new Error("Execution summary was not saved");
      return { kind: "recorded", record, summaryChanged, staleInput, evidenceAdded: fresh.length };
    });
  }

  async find(projectId: string, outcomeId: string): Promise<OutcomeExecutionRecord | null> {
    return this.load(this.database, projectId, outcomeId);
  }

  private async load(
    database: Kysely<Database>,
    projectId: string,
    outcomeId: string,
  ): Promise<OutcomeExecutionRecord | null> {
    const summary = await database
      .selectFrom("outcome_execution_summary")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("outcome_id", "=", outcomeId)
      .executeTakeFirst();
    if (!summary) return null;
    const evidence = await database
      .selectFrom("outcome_execution_evidence")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("outcome_id", "=", outcomeId)
      .orderBy("observed_at", "asc")
      .orderBy("created_at", "asc")
      .orderBy(sql`rowid`, "asc")
      .execute();
    return { summary: toSummary(summary), evidence: evidence.map(toEvidence) };
  }
}
