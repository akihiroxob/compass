import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { sql } from "kysely";
import { createDatabase } from "../../server/src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../../server/src/bootstrap/database/initializeSchema.ts";
import { MigrateDatabaseUseCase } from "../../database/src/MigrateDatabaseUseCase.ts";
import { FileMigrationSource } from "../../database/src/FileMigrationSource.ts";
import { SqliteMigrationRepository } from "../../database/src/SqliteMigrationRepository.ts";

const migrateSqlite = (path: string, directory?: string) => new MigrateDatabaseUseCase(new FileMigrationSource(directory), new SqliteMigrationRepository(path)).execute();

test("initial migration matches the current schema and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-migrations-"));
  const path = join(directory, "database.sqlite");
  const reference = createDatabase(":memory:");
  try {
    await initializeSchema(reference);
    assert.deepEqual(await migrateSqlite(path), ["0001_initial_schema.sql"]);
    assert.deepEqual(await migrateSqlite(path), []);
    const actual = new Database(path, { readonly: true });
    try {
      const expected = (await sql`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE ${"sqlite_%"} ORDER BY type, name`.execute(reference)).rows;
      const found = actual.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'compass_schema_migration' ORDER BY type, name").all();
      assert.deepEqual(found, expected);
    } finally { actual.close(); }
  } finally {
    await reference.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

