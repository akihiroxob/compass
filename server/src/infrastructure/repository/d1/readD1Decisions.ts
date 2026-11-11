import type { D1Database } from "@cloudflare/workers-types";
import { type Kysely, type Selectable, type SelectQueryBuilder } from "kysely";
import { decisionsFromRecords, type DirectionDatabase, type DirectionDecisionTable } from "@compass/direction";

export const readD1Decisions = async (database: Kysely<DirectionDatabase>, binding: D1Database,
  query: SelectQueryBuilder<DirectionDatabase, "direction_decision", Selectable<DirectionDecisionTable>>) => {
  const ids = query.clearOrderBy().clearSelect().select("id");
  const syntheses = database.selectFrom("direction_decision_synthesis").selectAll().where("decision_id", "in", ids).orderBy("position");
  const findings = database.selectFrom("direction_decision_finding").selectAll().where("decision_id", "in", ids).orderBy("position");
  const batch = await binding.batch([query, syntheses, findings].map((builder) => {
    const compiled = builder.compile(); return binding.prepare(compiled.sql).bind(...compiled.parameters);
  }));
  return decisionsFromRecords(batch[0]!.results as Selectable<DirectionDecisionTable>[],
    batch[1]!.results as { decision_id: string; synthesis_id: string; version: number; position: number }[],
    batch[2]!.results as { decision_id: string; finding_id: string; position: number }[]);
};
