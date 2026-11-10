import { sql, type Kysely } from "kysely";
import { canonicalProjectActivity, insertActivityQuery, type ActivityDatabase } from "@compass/activity";
import { findAdrReferencedRepositoryId, type DirectionDatabase } from "@compass/direction";
import { systemActivityActor, type ActivityActorContext } from "../../../application/activityActor.ts";
import type { D1ProjectArchivePlanner, D1ProjectReferenceChecks } from "./D1ProjectRepository.ts";

export const createD1ProjectReferenceChecks = (database: Kysely<DirectionDatabase>): D1ProjectReferenceChecks => ({
  findReferenced: (ids) => findAdrReferencedRepositoryId(database, ids),
  notReferenced: (ids) => sql`SELECT 1 WHERE NOT EXISTS ${
    database.selectFrom("adr_handoff_request").select("repository_id").where("repository_id", "in", ids)
  } AND NOT EXISTS ${
    database.selectFrom("adr_reference").select("repository_id").where("repository_id", "in", ids)
  }`.compile(database),
});

export const planD1ProjectArchiveActivity = (database: Kysely<ActivityDatabase>, actors: ActivityActorContext): D1ProjectArchivePlanner =>
  (notice) => insertActivityQuery(database, canonicalProjectActivity({ ...notice, ...(actors.current() ?? systemActivityActor) })).compile();
