import type { Kysely } from "kysely";
import { initializeAccessSchema } from "@compass/access";
import { initializeActivitySchema } from "@compass/activity";
import { initializeDirectionSchema } from "@compass/direction";
import { initializeOrganizationSchema } from "@compass/organization";
import { initializeWorkSchema } from "@compass/work";
import {
  asAccessDatabase,
  asActivityDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
  asWorkDatabase,
} from "./contextDatabase.ts";
import type { Database } from "./schema.ts";

/** Organizationを先に作る。他Contextのtableが`workspace`を参照する列は移行の後続Taskで加える。 */
export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeOrganizationSchema(asOrganizationDatabase(database));
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
  await initializeActivitySchema(asActivityDatabase(database));
};
