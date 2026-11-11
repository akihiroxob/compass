import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type { EvidenceReference, ResearchFinding, ResearchRequestDetail, ResearchResult, ResearchSynthesis } from "../domain/Research.ts";
import type { DirectionDatabase, ResearchEvidenceRefTable, ResearchFindingTable, ResearchRequestTable, ResearchResultTable, ResearchSynthesisTable } from "./schema.ts";
import { toRequest } from "./researchRequestRecord.ts";

type Executor = Kysely<DirectionDatabase> | Transaction<DirectionDatabase>;

const parseList = (value: string): string[] => JSON.parse(value) as string[];

const byRowid = sql`rowid`;

const toEvidence = (row: Selectable<ResearchEvidenceRefTable>): EvidenceReference => ({
  id: row.id,
  workspaceId: row.workspace_id,
  resultId: row.result_id,
  position: row.position,
  kind: row.kind,
  uri: row.uri,
  retrievedAt: row.retrieved_at,
  versionHash: row.version_hash,
  resourceId: row.resource_id,
});

/** ResultのrowにEvidence参照とFindingを位置順で結び付ける。 */
export const loadResults = async (
  database: Executor,
  rows: Selectable<ResearchResultTable>[],
): Promise<ResearchResult[]> => {
  if (rows.length === 0) return [];
  const resultIds = rows.map((row) => row.id);
  const evidenceRows = await database
    .selectFrom("research_evidence_ref")
    .selectAll()
    .where("result_id", "in", resultIds)
    .orderBy("position", "asc")
    .execute();
  const findingRows: Selectable<ResearchFindingTable>[] = await database
    .selectFrom("research_finding")
    .selectAll()
    .where("result_id", "in", resultIds)
    .orderBy("position", "asc")
    .execute();
  const findingIds = findingRows.map((row) => row.id);
  const evidenceLinks =
    findingIds.length === 0
      ? []
      : await database
          .selectFrom("research_finding_evidence")
          .selectAll()
          .where("finding_id", "in", findingIds)
          .orderBy("position", "asc")
          .execute();
  const conflictLinks =
    findingIds.length === 0
      ? []
      : await database
          .selectFrom("research_finding_conflict")
          .selectAll()
          .where("finding_id", "in", findingIds)
          .orderBy(byRowid, "asc")
          .execute();

  return researchResultsFromRecords(rows, evidenceRows, findingRows, evidenceLinks, conflictLinks);
};

export const researchResultsFromRecords = (
  rows: Selectable<ResearchResultTable>[], evidenceRows: Selectable<ResearchEvidenceRefTable>[],
  findingRows: Selectable<ResearchFindingTable>[], evidenceLinks: { finding_id: string; evidence_ref_id: string; position: number }[],
  conflictLinks: { finding_id: string; conflicting_finding_id: string }[],
): ResearchResult[] => {
  const findings = findingRows.map(
    (row): ResearchFinding => ({
      id: row.id,
      workspaceId: row.workspace_id,
      requestId: row.request_id,
      resultId: row.result_id,
      position: row.position,
      statement: row.statement,
      confidence: row.confidence,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      evidenceRefIds: evidenceLinks.filter((link) => link.finding_id === row.id).map((link) => link.evidence_ref_id),
      conflictsWithFindingIds: conflictLinks
        .filter((link) => link.finding_id === row.id)
        .map((link) => link.conflicting_finding_id),
      principalId: row.principal_id,
      runRef: row.run_ref,
      createdAt: row.created_at,
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    sequence: row.sequence,
    summary: row.summary,
    unknowns: parseList(row.unknowns),
    options: parseList(row.options),
    risks: parseList(row.risks),
    budgetUsed: row.budget_used,
    evidenceRefs: evidenceRows.filter((item) => item.result_id === row.id).map(toEvidence),
    findings: findings.filter((item) => item.resultId === row.id),
    principalId: row.principal_id,
    runRef: row.run_ref,
    createdAt: row.created_at,
  }));
};

export const loadSyntheses = async (
  database: Executor,
  rows: Selectable<ResearchSynthesisTable>[],
): Promise<ResearchSynthesis[]> => {
  if (rows.length === 0) return [];
  const links = await database
    .selectFrom("research_synthesis_finding")
    .selectAll()
    .where(
      "synthesis_id",
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("position", "asc")
    .execute();
  return researchSynthesesFromRecords(rows, links);
};

export const researchSynthesesFromRecords = (
  rows: Selectable<ResearchSynthesisTable>[], links: { synthesis_id: string; finding_id: string; position: number }[],
): ResearchSynthesis[] => {
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    version: row.version,
    supersedesId: row.supersedes_id,
    conclusion: row.conclusion,
    findingIds: links.filter((link) => link.synthesis_id === row.id).map((link) => link.finding_id),
    risks: parseList(row.risks),
    options: parseList(row.options),
    unknowns: parseList(row.unknowns),
    validAsOf: row.valid_as_of,
    principalId: row.principal_id,
    runRef: row.run_ref,
    createdAt: row.created_at,
  }));
};

export const loadDetail = async (
  database: Executor,
  requestRow: Selectable<ResearchRequestTable>,
): Promise<ResearchRequestDetail> => {
  const resultRows = await database
    .selectFrom("research_result")
    .selectAll()
    .where("request_id", "=", requestRow.id)
    .orderBy("sequence", "asc")
    .execute();
  const synthesisRows = await database
    .selectFrom("research_synthesis")
    .selectAll()
    .where("request_id", "=", requestRow.id)
    .orderBy(byRowid, "asc")
    .execute();
  return {
    request: toRequest(requestRow),
    results: await loadResults(database, resultRows),
    syntheses: await loadSyntheses(database, synthesisRows),
  };
};

/** 別WorkspaceのRequest IDは存在しないものとして扱う。 */
export const findRequestRow = (database: Executor, workspaceId: string, requestId: string) =>
  database
    .selectFrom("research_request")
    .selectAll()
    .where("id", "=", requestId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();

