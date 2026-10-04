import type { Kysely } from "kysely";
import { initializeAccessSchema } from "@compass/access";
import { initializeActivitySchema } from "@compass/activity";
import { initializeDirectionSchema } from "@compass/direction";
import { initializeWorkSchema } from "@compass/work";
import { asAccessDatabase, asActivityDatabase, asDirectionDatabase, asWorkDatabase } from "./contextDatabase.ts";
import type { Database } from "./schema.ts";

export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
  await initializeActivitySchema(asActivityDatabase(database));
};
