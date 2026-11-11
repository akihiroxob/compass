import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { Database } from "../infrastructure/database/schema.ts";
import { asWorkDatabase } from "../infrastructure/database/contextDatabase.ts";
import { workExternalReaders } from "../infrastructure/repository/workReaders.ts";
import { D1WorkStore } from "../infrastructure/repository/d1/D1WorkStore.ts";
import { planD1WorkActivity } from "../infrastructure/repository/d1/planD1WorkActivity.ts";

export const createD1WorkInfrastructure = (database: Kysely<Database>, binding: D1Database) =>
  new D1WorkStore(asWorkDatabase(database), binding, workExternalReaders, planD1WorkActivity);
