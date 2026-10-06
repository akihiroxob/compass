import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { OrganizationDatabase } from "../../src/index.ts";

/** Organizationのtableだけを持つSQLite。serverの合成（他Contextのtable）なしでOrganizationを検証する。 */
export const createOrganizationDatabase = (path = ":memory:") => {
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<OrganizationDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
};

/** ADR Handoff（Direction）からの参照が無い前提の`ProjectRepositoryReferenceFinder`。 */
export const noRepositoryReference = async (): Promise<string | null> => null;
