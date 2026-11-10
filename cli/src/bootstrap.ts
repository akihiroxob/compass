import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import {
  GrantProjectRoleUseCase, RevokeProjectRoleUseCase, ListProjectGrantsUseCase,
  SQLiteProjectGrantRepository, type AccessDatabase, type AccessProjectReaders,
} from "@compass/access";
import {
  projectExists, isProjectArchived, findProjectWorkspaceId, type OrganizationDatabase,
} from "@compass/organization";

/** CLIが必要とするGrant操作だけを組み立てる。HTTP Serverは生成しない。 */
export const createCliServices = (path: string) => {
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  const database = new Kysely<AccessDatabase & OrganizationDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  const readers: AccessProjectReaders = (executor) => {
    const organization = executor as unknown as Kysely<OrganizationDatabase>;
    return {
      exists: (id) => projectExists(organization, id),
      isArchived: (id) => isProjectArchived(organization, id),
      findWorkspaceId: (id) => findProjectWorkspaceId(organization, id),
    };
  };
  const access = database as unknown as Kysely<AccessDatabase>;
  const repository = new SQLiteProjectGrantRepository(access, readers);
  const projects = readers(access);
  return {
    services: {
      grantProjectRoleUseCase: new GrantProjectRoleUseCase(projects, repository),
      revokeProjectRoleUseCase: new RevokeProjectRoleUseCase(projects, repository),
      listProjectGrantsUseCase: new ListProjectGrantsUseCase(projects, repository),
    },
    close: () => database.destroy(),
  };
};
