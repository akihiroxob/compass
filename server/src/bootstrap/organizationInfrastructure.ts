import { SQLiteProjectRepository, SQLiteWorkspaceRepository, type ProjectRepository, type WorkspaceRepository } from "@compass/organization";
import type { Kysely } from "kysely";
import type { Database } from "./database/schema.ts";
import { asOrganizationDatabase } from "./database/contextDatabase.ts";
import {
  projectChangeActivityObserver,
  projectRepositoryReferenceFinder,
  workspaceOwnerMembershipWriter,
} from "../infrastructure/repository/contextAdapters.ts";

/** OrganizationのUse Caseが必要とする永続化契約。実装はトランザクションを含む契約を守る。 */
export type OrganizationInfrastructure = {
  projectRepository: ProjectRepository;
  workspaceRepository: WorkspaceRepository;
};

/** SQLiteと、同じトランザクションに参加するContext間の接続。 */
export const createSqliteOrganizationInfrastructure = (database: Kysely<Database>): OrganizationInfrastructure => {
  const organizationDatabase = asOrganizationDatabase(database);
  return {
    projectRepository: new SQLiteProjectRepository(
      organizationDatabase,
      projectRepositoryReferenceFinder,
      workspaceOwnerMembershipWriter,
      projectChangeActivityObserver,
    ),
    workspaceRepository: new SQLiteWorkspaceRepository(organizationDatabase, workspaceOwnerMembershipWriter),
  };
};
