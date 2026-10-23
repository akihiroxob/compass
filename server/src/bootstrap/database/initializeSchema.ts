import type { Kysely } from "kysely";
import { initializeAccessSchema } from "@compass/access";
import { initializeActivitySchema } from "@compass/activity";
import { initializeCollaborationSchema } from "@compass/collaboration";
import { initializeDirectionSchema } from "@compass/direction";
import { initializeOrganizationSchema } from "@compass/organization";
import { initializeWorkSchema } from "@compass/work";
import {
  asAccessDatabase,
  asActivityDatabase,
  asCollaborationDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
  asWorkDatabase,
} from "./contextDatabase.ts";
import type { Database } from "./schema.ts";

/**
 * 新規DBのschemaを作る。同じschemaのDBへは再適用でき（冪等）、旧定義のDBの変換・データ補完は行わない（DBを再作成する）。
 * Organization（Workspace・Project）を先に作る。他Contextのtableが`workspace`・`project`を参照するため。
 */
export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeOrganizationSchema(asOrganizationDatabase(database));
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
  await initializeActivitySchema(asActivityDatabase(database));
  await initializeCollaborationSchema(asCollaborationDatabase(database));
};
