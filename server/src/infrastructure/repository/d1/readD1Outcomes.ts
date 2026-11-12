import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable, type SelectQueryBuilder } from "kysely";
import { outcomeProblemsFromRecords, outcomesFromRecords, type DirectionDatabase, type OutcomeTable,
  type OutcomeProblemTable, type OutcomeEvidenceRecord, type SuccessCriterionTable } from "@compass/direction";

export type D1OutcomeQuery = SelectQueryBuilder<DirectionDatabase, "outcome", Selectable<OutcomeTable>>;

/** すべてのSELECTを同じbatchで読み、Outcomeと可変の課題を同じsnapshotから組み立てる。 */
export const d1OutcomeSnapshotQueries = (database: Kysely<DirectionDatabase>, query: D1OutcomeQuery) => {
  const ids = query.clearOrderBy().clearSelect().select("outcome.id");
  const problems = database.selectFrom("outcome_problem").selectAll().where("outcome_id", "in", ids).orderBy("position");
  const criteria = database.selectFrom("success_criterion").selectAll().where("outcome_id", "in", ids).orderBy("position");
  const evidence = database.selectFrom("outcome_problem_evidence as e")
    .leftJoin("research_finding as f", "f.id", "e.finding_id")
    .leftJoin("research_synthesis as s", "s.id", "e.synthesis_id")
    .select(["e.problem_id", "e.finding_id", "e.synthesis_id", "f.request_id as finding_request_id", "f.statement",
      "s.request_id as synthesis_request_id", "s.conclusion",
      sql<number>`EXISTS (SELECT 1 FROM research_synthesis AS newer WHERE newer.supersedes_id = e.synthesis_id)`.as("superseded")])
    .where("e.problem_id", "in", problems.clearSelect().clearOrderBy().select("id")).orderBy("e.position");
  return [query, criteria, problems, evidence].map((builder) => builder.compile());
};

export const outcomesFromD1Results = (results: D1Result[]) => {
  // 各結果の型は直上のSELECT列で固定する。入力値はすべてbindする。
  return outcomesFromRecords(results[0]!.results as Selectable<OutcomeTable>[], results[1]!.results as Selectable<SuccessCriterionTable>[],
    outcomeProblemsFromRecords(results[2]!.results as Selectable<OutcomeProblemTable>[], results[3]!.results as OutcomeEvidenceRecord[]));
};

export const readD1Outcomes = async (database: Kysely<DirectionDatabase>, binding: D1Database, query: D1OutcomeQuery) => {
  const statements = d1OutcomeSnapshotQueries(database, query).map((compiled) => binding.prepare(compiled.sql).bind(...compiled.parameters));
  return outcomesFromD1Results(await binding.batch(statements));
};
