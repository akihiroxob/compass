import type { Kysely } from "kysely";
import { initializeAccessSchema } from "@compass/access";
import { initializeDirectionSchema } from "@compass/direction";
import { initializeWorkSchema } from "@compass/work";
import { asAccessDatabase, asDirectionDatabase, asWorkDatabase } from "./contextDatabase.ts";
import type { Database } from "./schema.ts";

export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
};
