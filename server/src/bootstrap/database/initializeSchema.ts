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

/**
 * Organization（Workspace・Project）を先に作る。他Contextのtableが`project`を参照するため。Organizationの初期化は
 * 既存Projectの戦略値の所属Workspaceへの移行を含む。Direction各tableの`workspace_id`は移行の後続Taskで加える。
 */
export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeOrganizationSchema(asOrganizationDatabase(database));
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
  await initializeActivitySchema(asActivityDatabase(database));
};
