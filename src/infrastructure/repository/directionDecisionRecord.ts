import type { Kysely, Selectable, Transaction } from "kysely";
import type { DirectionDecision } from "../../domain/model/DirectionDecision.ts";
import type { IntentResearchSummary } from "../../domain/model/Research.ts";
import type { CreateDirectionDecisionInput } from "../../shared/directionDecisionSchema.ts";
import type { Database, DirectionDecisionTable } from "../database/schema.ts";

type Executor = Kysely<Database> | Transaction<Database>;

type CommonDecisionFields = Pick<
  CreateDirectionDecisionInput,
  "intentId" | "judgment" | "reason" | "options" | "usedSyntheses" | "usedFindingIds" | "requestKey" | "runRef"
> & { principalId: string };

/** Decision行と、関連tableに保存したusedSyntheses・usedFindingIdsを結び付けて読取モデルへ変換する。 */
const loadDecisions = async (
  database: Executor,
  rows: Selectable<DirectionDecisionTable>[],
): Promise<DirectionDecision[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const synthesisLinks = await database
    .selectFrom("direction_decision_synthesis")
    .selectAll()
    .where("decision_id", "in", ids)
    .orderBy("position", "asc")
    .execute();
  const findingLinks = await database
    .selectFrom("direction_decision_finding")
    .selectAll()
    .where("decision_id", "in", ids)
    .orderBy("position", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    intentId: row.intent_id,
    outcomeId: row.outcome_id,
    type: row.type,
    judgment: row.judgment,
    reason: row.reason,
    options: JSON.parse(row.options) as string[],
    usedSyntheses: synthesisLinks
      .filter((link) => link.decision_id === row.id)
      .map((link) => ({ synthesisId: link.synthesis_id, version: link.version })),
    usedFindingIds: findingLinks.filter((link) => link.decision_id === row.id).map((link) => link.finding_id),
    principalId: row.principal_id,
    runRef: row.run_ref,
    intentBriefSnapshot: JSON.parse(row.intent_brief_snapshot) as IntentResearchSummary,
    requestKey: row.request_key,
    createdAt: row.created_at,
  }));
};

export const findDecisionByRequestKey = (transaction: Transaction<Database>, projectId: string, requestKey: string) =>
  transaction
    .selectFrom("direction_decision")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("request_key", "=", requestKey)
    .executeTakeFirst();

/**
 * 使用したSynthesis・Findingが同じProjectに存在し、Synthesisは指定versionが現在versionと一致することを検証する。
 * 不一致は呼び出し側が`invalid_reference` / `synthesis_version_mismatch`として拒否する。
 */
export const validateResearchReferences = async (
  transaction: Transaction<Database>,
  projectId: string,
  usedSyntheses: readonly { synthesisId: string; version: number }[],
  usedFindingIds: readonly string[],
):
  Promise<
    | { kind: "ok" }
    | { kind: "invalid_reference"; reference: "synthesis" | "finding"; ids: string[] }
    | { kind: "synthesis_version_mismatch"; synthesisId: string; expected: number; actual: number }
  > => {
  if (usedSyntheses.length > 0) {
    const rows = await transaction
      .selectFrom("research_synthesis")
      .select(["id", "version"])
      .where("project_id", "=", projectId)
      .where(
        "id",
        "in",
        usedSyntheses.map((item) => item.synthesisId),
      )
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row.version]));
    const missing = usedSyntheses.filter((item) => !byId.has(item.synthesisId)).map((item) => item.synthesisId);
    if (missing.length > 0) return { kind: "invalid_reference", reference: "synthesis", ids: missing };
    for (const item of usedSyntheses) {
      const actual = byId.get(item.synthesisId)!;
      if (actual !== item.version) {
        return { kind: "synthesis_version_mismatch", synthesisId: item.synthesisId, expected: item.version, actual };
      }
    }
  }
  if (usedFindingIds.length > 0) {
    const rows = await transaction
      .selectFrom("research_finding")
      .select("id")
      .where("project_id", "=", projectId)
      .where("id", "in", [...usedFindingIds])
      .execute();
    const known = new Set(rows.map((row) => row.id));
    const missing = usedFindingIds.filter((id) => !known.has(id));
    if (missing.length > 0) return { kind: "invalid_reference", reference: "finding", ids: missing };
  }
  return { kind: "ok" };
};

/**
 * Decision行と、usedSyntheses・usedFindingIdsの関連行を挿入する。参照検証・requestKeyの重複確認は呼び出し側が行う。
 * `outcomeId`はnext_outcomeのときだけ渡し、Outcome行が既に同一transaction内で作成済みであること（FKの前提）を呼び出し側が保証する。
 * `hash`はnext_outcomeならOutcome内容も含めた全入力のhashを呼び出し側が計算して渡す（再送の同一性判定に使うため）。
 */
export const insertDirectionDecisionRow = async (
  transaction: Transaction<Database>,
  projectId: string,
  id: string,
  type: DirectionDecision["type"],
  outcomeId: string | null,
  intentBriefSnapshot: IntentResearchSummary,
  input: CommonDecisionFields,
  hash: string,
  now: number,
): Promise<DirectionDecision> => {
  const row = await transaction
    .insertInto("direction_decision")
    .values({
      id,
      project_id: projectId,
      intent_id: input.intentId,
      outcome_id: outcomeId,
      type,
      judgment: input.judgment,
      reason: input.reason,
      options: JSON.stringify(input.options),
      intent_brief_snapshot: JSON.stringify(intentBriefSnapshot),
      principal_id: input.principalId,
      run_ref: input.runRef,
      request_key: input.requestKey,
      input_hash: hash,
      created_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (input.usedSyntheses.length > 0) {
    await transaction
      .insertInto("direction_decision_synthesis")
      .values(
        input.usedSyntheses.map((item, position) => ({
          decision_id: row.id,
          synthesis_id: item.synthesisId,
          version: item.version,
          position,
        })),
      )
      .execute();
  }
  if (input.usedFindingIds.length > 0) {
    await transaction
      .insertInto("direction_decision_finding")
      .values(
        input.usedFindingIds.map((findingId, position) => ({
          decision_id: row.id,
          finding_id: findingId,
          position,
        })),
      )
      .execute();
  }
  const [decision] = await loadDecisions(transaction, [row]);
  return decision!;
};

export { loadDecisions };
