import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileMigrationSource } from "../../database/src/FileMigrationSource.ts";
import { FileMigrationDistribution } from "../../database/src/FileMigrationDistribution.ts";
import { PrepareD1MigrationsUseCase } from "../../database/src/PrepareD1MigrationsUseCase.ts";

const execute = promisify(execFile);
const wrangler = fileURLToPath(new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url));

test("Wrangler explicitly applies the generated D1 migrations locally once and enforces atomic guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-d1-migration-integration-"));
  try {
    const migrations = join(directory, "migrations");
    const names = await new PrepareD1MigrationsUseCase(new FileMigrationSource(),
      new FileMigrationSource(fileURLToPath(new URL("../../database/d1/migrations/", import.meta.url))), new FileMigrationDistribution(migrations)).execute();
    const config = join(directory, "wrangler.json");
    await writeFile(config, JSON.stringify({ name: "compass-migration-test", compatibility_date: "2026-11-10", d1_databases: [{
      binding: "DB", database_name: "compass-migration-test", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: migrations,
    }] }));
    const cli = async (...args: string[]) => (await execute(process.execPath, [wrangler, "d1", ...args, "--local", "--config", config, "--persist-to", join(directory, "state")],
      { env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, maxBuffer: 2 * 1024 * 1024 })).stdout;
    await cli("migrations", "apply", "DB");
    await cli("migrations", "apply", "DB");
    const response = JSON.parse(await cli("execute", "DB", "--json", "--command", "SELECT name FROM d1_migrations ORDER BY id;")) as { results: { name: string }[] }[];
    assert.deepEqual(response[0]!.results.map(({ name }) => name), names);
    const tables = JSON.parse(await cli("execute", "DB", "--json", "--command", "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('compass_d1_guard', 'workspace', 'task_claim') ORDER BY name;")) as { results: { name: string }[] }[];
    assert.deepEqual(tables[0]!.results.map(({ name }) => name), ["compass_d1_guard", "task_claim", "workspace"]);
    await assert.rejects(cli("execute", "DB", "--command", "INSERT INTO compass_d1_guard (id, satisfied) VALUES ('failure', 0);"), /compass_d1_precondition/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
