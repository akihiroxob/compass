import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { DirectionDatabase } from "../../src/index.ts";

/** Directionのtableだけを持つSQLite。serverの合成（Access・Workのtable）なしでDirectionを検証する。 */
export const createDirectionDatabase = (path = ":memory:") => {
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<DirectionDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
};
