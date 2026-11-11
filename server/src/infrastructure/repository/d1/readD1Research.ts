import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable, type SelectQueryBuilder } from "kysely";
import { researchRequestFromRow, researchResultsFromRecords, researchSynthesesFromRecords,
  type DirectionDatabase, type ResearchRequestTable, type ResearchResultTable, type ResearchEvidenceRefTable,
  type ResearchFindingTable, type ResearchSynthesisTable } from "@compass/direction";

type RequestQuery = SelectQueryBuilder<DirectionDatabase, "research_request", Selectable<ResearchRequestTable>>;
type ResultQuery = SelectQueryBuilder<DirectionDatabase, "research_result", Selectable<ResearchResultTable>>;

/** 可変Requestと追記専用の結果・根拠を、同じbatchのsnapshotから読む。IDリストはSQLのsubqueryで渡す。 */
export const readD1Research = async (database: Kysely<DirectionDatabase>, binding: D1Database, requests: RequestQuery, resultScope?: ResultQuery, summaryOrder = false) => {
  const requestIds = requests.clearSelect().clearOrderBy().select("id");
  const results = resultScope ?? database.selectFrom("research_result").selectAll().where("request_id", "in", requestIds).orderBy("sequence");
  const resultIds = results.clearSelect().clearOrderBy().select("id");
  const baseSyntheses = database.selectFrom("research_synthesis").selectAll().where("request_id", "in", requestIds);
  const syntheses = summaryOrder ? baseSyntheses.orderBy("valid_as_of", "desc").orderBy(sql`rowid`, "desc") : baseSyntheses.orderBy(sql`rowid`);
  const synthesisIds = syntheses.clearSelect().clearOrderBy().select("id");
  const synthesisLinks = database.selectFrom("research_synthesis_finding").selectAll().where("synthesis_id", "in", synthesisIds).orderBy("position");
  const citedFindings = synthesisLinks.clearOrderBy().clearSelect().select("finding_id");
  const findings = database.selectFrom("research_finding").selectAll().where((eb) => eb.or([
    eb("result_id", "in", resultIds), eb("id", "in", citedFindings),
  ])).orderBy("position");
  const findingIds = findings.clearSelect().clearOrderBy().select("id");
  const evidence = database.selectFrom("research_evidence_ref").selectAll().where("result_id", "in", resultIds).orderBy("position");
  const links = database.selectFrom("research_finding_evidence").selectAll().where("finding_id", "in", findingIds).orderBy("position");
  const conflicts = database.selectFrom("research_finding_conflict").selectAll().where((eb) => eb.or([
    eb("finding_id", "in", findingIds), eb("conflicting_finding_id", "in", findingIds),
  ])).orderBy(sql`rowid`);
  const statements = [requests, results, evidence, findings, links, conflicts, syntheses, synthesisLinks].map((builder) => {
    const query = builder.compile(); return binding.prepare(query.sql).bind(...query.parameters);
  });
  const batch = await binding.batch(statements);
  const requestRows = batch[0]!.results as Selectable<ResearchRequestTable>[];
  const findingRows = batch[3]!.results as Selectable<ResearchFindingTable>[];
  const conflictRows = batch[5]!.results as { finding_id: string; conflicting_finding_id: string }[];
  return { requestRows, findingRows, conflictRows, requests: requestRows.map(researchRequestFromRow),
    results: researchResultsFromRecords(batch[1]!.results as Selectable<ResearchResultTable>[], batch[2]!.results as Selectable<ResearchEvidenceRefTable>[],
      findingRows, batch[4]!.results as { finding_id: string; evidence_ref_id: string; position: number }[], conflictRows),
    syntheses: researchSynthesesFromRecords(batch[6]!.results as Selectable<ResearchSynthesisTable>[],
      batch[7]!.results as { synthesis_id: string; finding_id: string; position: number }[]),
  };
};
