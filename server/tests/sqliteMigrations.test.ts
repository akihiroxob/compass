import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { sql } from "kysely";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { migrateSqlite } from "../src/bootstrap/database/migrateSqlite.ts";

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

test("existing unversioned DB is preserved and failed migration rolls back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-migrations-"));
  try {
    const existingPath = join(directory, "existing.sqlite");
    const existing = new Database(existingPath);
    existing.exec("CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('keep')");
    existing.close();
    await assert.rejects(migrateSqlite(existingPath), /no migration history/);
    const check = new Database(existingPath, { readonly: true });
    assert.deepEqual(check.prepare("SELECT value FROM important").get(), { value: "keep" });
    check.close();

    const migrations = join(directory, "migrations");
    await mkdir(migrations);
    await writeFile(join(migrations, "0001_test.sql"), "CREATE TABLE example (id INTEGER); INVALID SQL;");
    const failedPath = join(directory, "failed.sqlite");
    await assert.rejects(migrateSqlite(failedPath, migrations));
    const failed = new Database(failedPath, { readonly: true });
    assert.equal(failed.prepare("SELECT name FROM sqlite_master WHERE name IN ('example', 'compass_schema_migration')").all().length, 0);
    failed.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
