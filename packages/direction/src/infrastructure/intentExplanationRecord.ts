import type { Kysely, Selectable, CompiledQuery } from "kysely";
import { inputHash } from "@compass/shared";
import type { IntentExplanation, IntentExplanationBasisReference } from "../domain/IntentExplanation.ts";
import type { RecordIntentExplanationInput } from "../domain/IntentExplanationRepository.ts";
import type { DirectionDatabase, IntentExplanationTable, IntentExplanationItemTable, IntentExplanationBasisTable, IntentExplanationOutcomeTable } from "./schema.ts";
type Executor = Kysely<DirectionDatabase>;

const basisColumn = {
  metric_observation: "observation_id",
  finding: "finding_id",
  synthesis: "synthesis_id",
  evaluation: "evaluation_id",
  decision: "decision_id",
} as const;

/** 説明のrowから、項目・根拠・関連Outcomeを集めて組み立てる。 */
export const loadIntentExplanations = async (executor: Executor, rows: Selectable<IntentExplanationTable>[]): Promise<IntentExplanation[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [items, basis, outcomes] = await Promise.all([
    executor.selectFrom("intent_explanation_item").selectAll().where("explanation_id", "in", ids).orderBy("position", "asc").execute(),
    executor.selectFrom("intent_explanation_basis").selectAll().where("explanation_id", "in", ids).orderBy("item_position", "asc").orderBy("position", "asc").execute(),
    executor.selectFrom("intent_explanation_outcome").selectAll().where("explanation_id", "in", ids).orderBy("position", "asc").execute(),
  ]);
  return intentExplanationsFromRecords(rows, items, basis, outcomes);
};

export const intentExplanationsFromRecords = (rows: Selectable<IntentExplanationTable>[], items: Selectable<IntentExplanationItemTable>[],
  basis: Selectable<IntentExplanationBasisTable>[], outcomes: Selectable<IntentExplanationOutcomeTable>[]): IntentExplanation[] => {
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    intentId: row.intent_id,
    metricKey: row.metric_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    version: row.version,
    previousId: row.previous_id,
    changeFromPrevious: row.change_from_previous,
    relatedOutcomeIds: outcomes.filter((outcome) => outcome.explanation_id === row.id).map((outcome) => outcome.outcome_id),
    items: items
      .filter((item) => item.explanation_id === row.id)
      .map((item) => ({
        position: item.position,
        kind: item.kind,
        statement: item.statement,
        confidence: item.confidence,
        verification: item.verification,
        basedOn: JSON.parse(item.based_on) as number[],
        basis: basis
          .filter((entry) => entry.explanation_id === row.id && entry.item_position === item.position)
          .map((entry): IntentExplanationBasisReference => {
            if (entry.observation_id !== null) return { type: "metric_observation", id: entry.observation_id };
            if (entry.finding_id !== null) return { type: "finding", id: entry.finding_id };
            if (entry.synthesis_id !== null) return { type: "synthesis", id: entry.synthesis_id };
            if (entry.evaluation_id !== null) return { type: "evaluation", id: entry.evaluation_id };
            return { type: "decision", id: entry.decision_id! };
          }),
      })),
    principalId: row.principal_id,
    runRef: row.run_ref,
    requestKey: row.request_key,
    createdAt: row.created_at,
  }));
};

export const explanationReferenceQueries = (database: Executor, workspaceId: string, intentId: string, metricId: string, input: RecordIntentExplanationInput) => {
  const references: { path: string; id: string; message: string; query: CompiledQuery }[] = [];
  const add = (path: string, id: string, query: { compile(): CompiledQuery }, message: string) => references.push({ path, id, message, query: query.compile() });
  for (const [index, item] of input.items.entries()) {
    for (const [position, basis] of item.basis.entries()) {
      const path = `items[${index}].basis[${position}]`;
      switch (basis.type) {
        case "metric_observation": add(path, basis.id, database.selectFrom("intent_metric_observation").select("id").where("id", "=", basis.id).where("metric_id", "=", metricId), `metric_observation ${basis.id} was not found in Metric ${input.metricKey} of this Intent`); break;
        case "finding": add(path, basis.id, database.selectFrom("research_finding").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId), `finding ${basis.id} was not found in this Workspace`); break;
        case "synthesis": add(path, basis.id, database.selectFrom("research_synthesis").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId), `synthesis ${basis.id} was not found in this Workspace`); break;
        case "evaluation": add(path, basis.id, database.selectFrom("outcome_evaluation").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId), `evaluation ${basis.id} was not found for this Intent`); break;
        case "decision": add(path, basis.id, database.selectFrom("direction_decision").select("id").where("id", "=", basis.id).where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId), `decision ${basis.id} was not found for this Intent`); break;
      }
    }
  }
  input.relatedOutcomeIds.forEach((id, index) => add(`relatedOutcomeIds[${index}]`, id, database.selectFrom("outcome").select("id").where("id", "=", id)
    .where("workspace_id", "=", workspaceId).where("intent_id", "=", intentId), `outcome ${id} was not found for this Intent`));
  return references;
};

export const planIntentExplanationRecord = (database: Executor, workspaceId: string, intentId: string, principalId: string,
  input: RecordIntentExplanationInput, at: number, previous?: { id: string; version: number }) => {
  const row: Selectable<IntentExplanationTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, intent_id: intentId, metric_key: input.metricKey,
    period_start: input.periodStart, period_end: input.periodEnd, version: (previous?.version ?? 0) + 1, previous_id: previous?.id ?? null,
    change_from_previous: previous ? input.changeFromPrevious : null, principal_id: principalId, run_ref: input.runRef, request_key: input.requestKey,
    input_hash: inputHash({ intentId, ...input }), created_at: at };
  const items: Selectable<IntentExplanationItemTable>[] = input.items.map((item, position) => ({ explanation_id: row.id, position,
    kind: item.kind, statement: item.statement, confidence: item.confidence, verification: item.verification, based_on: JSON.stringify(item.basedOn) }));
  const basis: Selectable<IntentExplanationBasisTable>[] = input.items.flatMap((item, item_position) => item.basis.map((ref, position) => ({
    explanation_id: row.id, workspace_id: workspaceId, item_position, position, observation_id: null, finding_id: null, synthesis_id: null,
    evaluation_id: null, decision_id: null, [basisColumn[ref.type]]: ref.id })));
  const outcomes: Selectable<IntentExplanationOutcomeTable>[] = input.relatedOutcomeIds.map((outcome_id, position) => ({ explanation_id: row.id, workspace_id: workspaceId, outcome_id, position }));
  return { row, explanation: intentExplanationsFromRecords([row], items, basis, outcomes)[0]!, mutations: [database.insertInto("intent_explanation").values(row).compile(),
    ...items.map((item) => database.insertInto("intent_explanation_item").values(item).compile()),
    ...basis.map((item) => database.insertInto("intent_explanation_basis").values(item).compile()),
    ...outcomes.map((item) => database.insertInto("intent_explanation_outcome").values(item).compile())] };
};

