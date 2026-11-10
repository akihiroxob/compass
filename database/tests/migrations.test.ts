import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MigrateDatabaseUseCase } from "../src/MigrateDatabaseUseCase.ts";
import { FileMigrationSource } from "../src/FileMigrationSource.ts";
import { SqliteMigrationRepository } from "../src/SqliteMigrationRepository.ts";

const migrateSqlite = (path: string, directory?: string) => new MigrateDatabaseUseCase(new FileMigrationSource(directory), new SqliteMigrationRepository(path)).execute();

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
