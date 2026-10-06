import type { Selectable, Transaction } from "kysely";
import type { AdrHandoffRequest, AdrHandoffRequestPayload, AdrReference } from "../domain/AdrHandoff.ts";
import type { DirectionDatabase, AdrHandoffRequestTable, AdrReferenceTable } from "./schema.ts";

export const toRequest = (row: Selectable<AdrHandoffRequestTable>): AdrHandoffRequest => ({
  id: row.id,
  projectId: row.project_id,
  decisionId: row.decision_id,
  repositoryId: row.repository_id,
  correlationId: row.correlation_id,
  requestKey: row.request_key,
  payload: JSON.parse(row.payload) as AdrHandoffRequestPayload,
  principalId: row.principal_id,
  createdAt: row.created_at,
});

export const toReference = (row: Selectable<AdrReferenceTable>): AdrReference => ({
  id: row.id,
  projectId: row.project_id,
  decisionId: row.decision_id,
  repositoryId: row.repository_id,
  path: row.path,
  commitSha: row.commit_sha,
  pullRequestUrl: row.pull_request_url,
  correlationId: row.correlation_id,
  requestKey: row.request_key,
  principalId: row.principal_id,
  createdAt: row.created_at,
});

export type AdrCandidateDecision = {
  id: string;
  intentId: string;
  type: string;
  judgment: string;
  reason: string;
  options: string[];
};

/** decisionIdが同じProjectの行を指す場合だけ、adr_candidate判定に必要な列を返す。 */
export const findDecisionForHandoff = async (
  transaction: Transaction<DirectionDatabase>,
  projectId: string,
  decisionId: string,
): Promise<AdrCandidateDecision | null> => {
  const row = await transaction
    .selectFrom("direction_decision")
    .select(["id", "intent_id", "type", "judgment", "reason", "options"])
    .where("id", "=", decisionId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    intentId: row.intent_id,
    type: row.type,
    judgment: row.judgment,
    reason: row.reason,
    options: JSON.parse(row.options) as string[],
  };
};

const decisionEvidence = async (transaction: Transaction<DirectionDatabase>, decisionId: string) => {
  const [syntheses, findings] = await Promise.all([
    transaction
      .selectFrom("direction_decision_synthesis")
      .select(["synthesis_id", "version"])
      .where("decision_id", "=", decisionId)
      .orderBy("position", "asc")
      .execute(),
    transaction
      .selectFrom("direction_decision_finding")
      .select("finding_id")
      .where("decision_id", "=", decisionId)
      .orderBy("position", "asc")
      .execute(),
  ]);
  return {
    usedSyntheses: syntheses.map((row) => ({ synthesisId: row.synthesis_id, version: row.version })),
    usedFindingIds: findings.map((row) => row.finding_id),
  };
};

/**
 * `expectedAdrContent`をDecisionの`judgment` / `reason` / `options`から決定的に組み立てる。呼び出し側が別の
 * 自由記述を渡すのではなく、既に記録済みのDirection Decisionの内容だけを転記する（新しい方針を作らない）。
 */
const buildExpectedAdrContent = (decision: AdrCandidateDecision): string => {
  const optionsSection =
    decision.options.length > 0 ? `\n\n## Options considered\n${decision.options.map((option) => `- ${option}`).join("\n")}` : "";
  return `# ${decision.judgment}\n\n## Reason\n${decision.reason}${optionsSection}`;
};

export const buildAdrHandoffPayload = async (
  transaction: Transaction<DirectionDatabase>,
  decision: AdrCandidateDecision,
  repository: { id: string; name: string; url: string },
  constraints: string[],
): Promise<AdrHandoffRequestPayload> => {
  const { usedSyntheses, usedFindingIds } = await decisionEvidence(transaction, decision.id);
  return {
    decisionId: decision.id,
    intentId: decision.intentId,
    usedSyntheses,
    usedFindingIds,
    repositoryId: repository.id,
    repositoryName: repository.name,
    repositoryUrl: repository.url,
    constraints,
    expectedAdrContent: buildExpectedAdrContent(decision),
  };
};

export const findAdrHandoffRequestByKey = (transaction: Transaction<DirectionDatabase>, projectId: string, requestKey: string) =>
  transaction
    .selectFrom("adr_handoff_request")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("request_key", "=", requestKey)
    .executeTakeFirst();

export const findAdrHandoffRequestForReference = (
  transaction: Transaction<DirectionDatabase>,
  decisionId: string,
  repositoryId: string,
  correlationId: string,
) =>
  transaction
    .selectFrom("adr_handoff_request")
    .selectAll()
    .where("decision_id", "=", decisionId)
    .where("repository_id", "=", repositoryId)
    .where("correlation_id", "=", correlationId)
    .executeTakeFirst();

export const findAdrReferenceByKey = (transaction: Transaction<DirectionDatabase>, projectId: string, requestKey: string) =>
  transaction
    .selectFrom("adr_reference")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("request_key", "=", requestKey)
    .executeTakeFirst();
