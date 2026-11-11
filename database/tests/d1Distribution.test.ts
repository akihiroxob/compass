import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { FileMigrationSource } from "../src/FileMigrationSource.ts";
import { FileMigrationDistribution } from "../src/FileMigrationDistribution.ts";
import { PrepareD1MigrationsUseCase } from "../src/PrepareD1MigrationsUseCase.ts";
import { MigrateDatabaseUseCase } from "../src/MigrateDatabaseUseCase.ts";
import { SqliteMigrationRepository } from "../src/SqliteMigrationRepository.ts";

test("D1 distribution preserves canonical SQL and removes stale generated migrations without changing SQLite startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-d1-distribution-"));
  try {
    const output = join(directory, "migrations");
    const shared = new FileMigrationSource();
    const d1 = new FileMigrationSource(fileURLToPath(new URL("../d1/migrations/", import.meta.url)));
    const prepare = new PrepareD1MigrationsUseCase(shared, d1, new FileMigrationDistribution(output));
    const expected = [...await shared.load(), ...await d1.load()].sort((a, b) => a.name < b.name ? -1 : 1);
    assert.deepEqual(await prepare.execute(), expected.map(({ name }) => name));
    for (const migration of expected) assert.equal(await readFile(join(output, migration.name), "utf8"), migration.sql);
    await writeFile(join(output, "0099_removed.sql"), "SELECT 'stale';");
    await writeFile(join(output, "README.md"), "Not generated SQL");
    await prepare.execute();
    assert.deepEqual((await readdir(output)).sort(), [...expected.map(({ name }) => name), "README.md"].sort());
    const path = join(directory, "local.sqlite");
    await new MigrateDatabaseUseCase(shared, new SqliteMigrationRepository(path)).execute();
    const local = new Database(path, { readonly: true });
    try {
      assert.equal(local.prepare("SELECT name FROM sqlite_master WHERE name = 'compass_d1_guard'").get(), undefined);
      assert.ok(local.prepare("SELECT name FROM sqlite_master WHERE name = 'task_claim'").get());
    } finally { local.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid or colliding D1 migration names are rejected before publishing", async () => {
  let writes = 0;
  const destination = { write: async () => { writes++; } };
  const source = (name: string, sql = "SELECT 1;") => ({ load: async () => [{ name, sql }] });
  await assert.rejects(new PrepareD1MigrationsUseCase(source("0001_test.sql"), source("0001_test.sql"), destination).execute(), /Duplicate migration/);
  await assert.rejects(new PrepareD1MigrationsUseCase(source("0001_test.sql"), source("../escape.sql"), destination).execute(), /Invalid migration filename/);
  await assert.rejects(new PrepareD1MigrationsUseCase(source("0001_test.sql"), source("0000_empty.sql", " "), destination).execute(), /Migration is empty/);
  assert.equal(writes, 0);
});
