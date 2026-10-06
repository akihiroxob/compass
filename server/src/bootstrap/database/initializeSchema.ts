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
import {
  addProjectWorkspaceColumn,
  assignWorkspacesToUnassignedProjects,
} from "../../infrastructure/repository/projectWorkspace.ts";
import type { Database } from "./schema.ts";

/**
 * Organizationを先に作る。Direction（`project`）の後に`project.workspace_id`を加え、未所属の既存Projectを
 * それぞれのWorkspaceへ所属させる。Direction各tableの`workspace_id`は移行の後続Taskで加える。
 */
export const initializeSchema = async (database: Kysely<Database>): Promise<void> => {
  await initializeOrganizationSchema(asOrganizationDatabase(database));
  await initializeDirectionSchema(asDirectionDatabase(database));
  await addProjectWorkspaceColumn(database);
  await assignWorkspacesToUnassignedProjects(database);
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
  await initializeActivitySchema(asActivityDatabase(database));
};
