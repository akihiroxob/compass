import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.ts";

export const createDatabase = (path = process.env.COMPASS_DB_PATH || "compass.db") => {
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
};
