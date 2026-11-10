import Database from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import type { Database as Schema } from "./schema.ts";

const defaultDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

const migrationFiles = async (directory: string): Promise<string[]> => {
  const files = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error("Migration files are missing");
  return files;
};

/** schemaの変更は行わず、配布されたmigrationがすべて適用済みか確認する。 */
export const assertSqliteMigrationsApplied = async (database: Kysely<Schema>, directory = defaultDirectory): Promise<void> => {
  const files = await migrationFiles(directory);
  const exists = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compass_schema_migration'`.execute(database);
  if (!exists.rows.length) throw new Error("Database migration history is missing. Run npm run db:migrate with COMPASS_DB_PATH before starting Compass.");
  const result = await sql<{ name: string }>`SELECT name FROM compass_schema_migration`.execute(database);
  const applied = new Set(result.rows.map(({ name }) => name));
  const missing = files.filter((name) => !applied.has(name));
  const unknown = [...applied].filter((name) => !files.includes(name));
  if (missing.length || unknown.length) throw new Error(`Database migration history differs from this deployment (pending: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}). Run npm run db:migrate or use the matching deployment.`);
};

/** 未適用のSQLを名前順にまとめて原子的に適用する。既存DBを推測でbaselineにしない。 */
export const migrateSqlite = async (path: string, directory = defaultDirectory): Promise<string[]> => {
  const files = await migrationFiles(directory);
  const migrations = await Promise.all(files.map(async (name) => ({ name, sql: await readFile(`${directory}/${name}`, "utf8") })));
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    const apply = database.transaction(() => {
      const hasHistory = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compass_schema_migration'").get();
      if (!hasHistory) {
        const existing = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
        if (existing) throw new Error("Existing database has no migration history; use a new database or an explicit migration plan");
        database.exec("CREATE TABLE compass_schema_migration (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      }
      const applied = new Set((database.prepare("SELECT name FROM compass_schema_migration").all() as { name: string }[]).map(({ name }) => name));
      const unknown = [...applied].filter((name) => !files.includes(name));
      if (unknown.length) throw new Error(`Applied migration is missing from the distribution: ${unknown.join(", ")}`);
      if (files.some((name, index) => applied.has(name) && files.slice(0, index).some((prior) => !applied.has(prior)))) {
        throw new Error("Migration history is not in filename order");
      }
      const pending = migrations.filter(({ name }) => !applied.has(name));
      const record = database.prepare("INSERT INTO compass_schema_migration (name) VALUES (?)");
      for (const migration of pending) {
        database.exec(migration.sql);
        record.run(migration.name);
      }
      return pending.map(({ name }) => name);
    });
    return apply();
  } finally {
    database.close();
  }
};
