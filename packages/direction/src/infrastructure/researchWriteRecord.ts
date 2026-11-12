import type { Kysely, Selectable } from "kysely";
import { inputHash } from "@compass/shared";
import type { RegisterResearchResultInput, RegisterResearchSynthesisInput } from "../domain/ResearchRepository.ts";
import type { DirectionDatabase, ResearchResultTable, ResearchSynthesisTable } from "./schema.ts";
import { researchResultsFromRecords, researchSynthesesFromRecords } from "./researchReadRecord.ts";

/** 採番・正規化と子要素の保存SQLを共有し、実行・原子性の保証はRepositoryに委ねる。 */
export const planResearchResultRecord = (database: Kysely<DirectionDatabase>, workspaceId: string, requestId: string,
  input: RegisterResearchResultInput, sequence: number, now: number) => {
  const row: Selectable<ResearchResultTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, request_id: requestId, sequence,
    request_key: input.requestKey, input_hash: inputHash(input), summary: input.summary, unknowns: JSON.stringify(input.unknowns),
    options: JSON.stringify(input.options), risks: JSON.stringify(input.risks), budget_used: input.budgetUsed,
    principal_id: input.principalId, run_ref: input.runRef, created_at: now };
  const evidence = input.evidenceRefs.map((item, position) => ({ id: crypto.randomUUID(), workspace_id: workspaceId, result_id: row.id,
    position, kind: item.kind, uri: item.uri, retrieved_at: item.retrievedAt, version_hash: item.versionHash, resource_id: item.resourceId }));
  const findings = input.findings.map((item, position) => ({ id: crypto.randomUUID(), workspace_id: workspaceId, request_id: requestId,
    result_id: row.id, position, statement: item.statement, confidence: item.confidence, observed_at: item.observedAt,
    expires_at: item.expiresAt, principal_id: input.principalId, run_ref: input.runRef, created_at: now }));
  const links = input.findings.flatMap((item, index) => item.evidenceIndexes.map((evidenceIndex, position) => ({ finding_id: findings[index]!.id,
    evidence_ref_id: evidence[evidenceIndex]!.id, position })));
  const conflicts = input.findings.flatMap((item, index) => item.conflictsWithFindingIds.map((id) => ({ finding_id: findings[index]!.id, conflicting_finding_id: id })));
  const mutations = [database.insertInto("research_result").values(row).compile(),
    ...evidence.map((item) => database.insertInto("research_evidence_ref").values(item).compile()),
    ...findings.map((item) => database.insertInto("research_finding").values(item).compile()),
    ...links.map((item) => database.insertInto("research_finding_evidence").values(item).compile()),
    ...conflicts.map((item) => database.insertInto("research_finding_conflict").values(item).compile())];
  return { row, mutations, result: researchResultsFromRecords([row], evidence, findings, links, conflicts)[0]! };
};

export const planResearchSynthesisRecord = (database: Kysely<DirectionDatabase>, workspaceId: string, requestId: string,
  input: RegisterResearchSynthesisInput, version: number, now: number) => {
  const row: Selectable<ResearchSynthesisTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, request_id: requestId,
    request_key: input.requestKey, input_hash: inputHash(input), version, supersedes_id: input.supersedesId, conclusion: input.conclusion,
    risks: JSON.stringify(input.risks), options: JSON.stringify(input.options), unknowns: JSON.stringify(input.unknowns), valid_as_of: input.validAsOf,
    principal_id: input.principalId, run_ref: input.runRef, created_at: now };
  const links = input.findingIds.map((id, position) => ({ synthesis_id: row.id, finding_id: id, position }));
  return { row, mutations: [database.insertInto("research_synthesis").values(row).compile(),
    ...links.map((item) => database.insertInto("research_synthesis_finding").values(item).compile())],
    synthesis: researchSynthesesFromRecords([row], links)[0]! };
};
