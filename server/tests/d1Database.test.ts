import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { sql } from "kysely";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1Database, D1InteractiveTransactionUnsupportedError } from "../src/infrastructure/database/d1/D1Dialect.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../src/infrastructure/database/d1/D1AtomicBatch.ts";

const setup = async () => {
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "compass-d1-test",
      compatibilityDate: "2026-11-10",
      manifest: { mainModule: "index.js", modulesRoot: process.cwd(), modules: {
        "index.js": { type: "esm", contents: 'export default { fetch() { return new Response("test"); } };' },
      } },
      env: { DB: { type: "d1", id: "compass-d1-test" } },
    } }],
  });
  // MiniflareとアプリのCloudflare型の版を隔離する。実体はworkerdのD1 binding。
  const binding = await runtime.getD1Database("DB") as unknown as D1Database;
  const database = createD1Database(binding);
  return { runtime, binding, database };
};

test("D1 accepts the shared initial schema and Kysely preserves query values and RETURNING", async () => {
  const { runtime, binding, database } = await setup();
  try {
    const schema = await readFile(new URL("../../database/migrations/0001_initial_schema.sql", import.meta.url), "utf8");
    // 現行の初期DDLはtriggerや文字列内のsemicolonを含まない。execの行単位処理を避ける。
    await binding.batch(schema.split(";").filter((statement) => statement.trim()).map((statement) => binding.prepare(statement)));
    const workspace = await database.insertInto("workspace").values({
      id: "workspace", name: "O'Brien", mission: "Use D1", vision: null, created_at: 1, updated_at: 1,
      status: "active", archived_at: null, archive_reason: null,
    }).returningAll().executeTakeFirstOrThrow();
    assert.equal(workspace.name, "O'Brien");
    assert.equal((await database.selectFrom("workspace").selectAll().execute()).length, 1);
    await assert.rejects(database.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("workspace").execute();
    }), D1InteractiveTransactionUnsupportedError);
    assert.equal((await database.selectFrom("workspace").selectAll().execute()).length, 1);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 batches reject stale concurrent writes and roll back mutations on SQL failure", async () => {
  const { runtime, binding, database } = await setup();
  try {
    await binding.prepare(await readFile(new URL("../../database/d1/atomic-guards.sql", import.meta.url), "utf8")).run();
    await binding.batch([
      binding.prepare("CREATE TABLE counter (id TEXT PRIMARY KEY, version INTEGER NOT NULL)"),
      binding.prepare("CREATE TABLE event (id TEXT PRIMARY KEY)"),
      binding.prepare("INSERT INTO counter VALUES ('one', 0)"),
    ]);
    const writer = new D1AtomicBatch(binding);
    const guard = sql`select id from counter where id = ${"one"} and version = ${0}`.compile(database);
    const update = sql`update counter set version = version + 1 where id = ${"one"}`.compile(database);
    const results = await Promise.allSettled([
      writer.execute([guard], [update, sql`insert into event values (${"first"})`.compile(database)]),
      writer.execute([guard], [update, sql`insert into event values (${"second"})`.compile(database)]),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");
    assert.ok(failed?.status === "rejected" && failed.reason instanceof D1PreconditionFailedError);
    assert.equal((await binding.prepare("SELECT version FROM counter").first<{ version: number }>())?.version, 1);
    assert.equal((await binding.prepare("SELECT COUNT(*) AS n FROM event").first<{ n: number }>())?.n, 1);
    assert.equal((await binding.prepare("SELECT COUNT(*) AS n FROM compass_d1_guard").first<{ n: number }>())?.n, 0);
    await assert.rejects(writer.execute([], [update, sql`insert into missing_table values (1)`.compile(database)]));
    assert.equal((await binding.prepare("SELECT version FROM counter").first<{ version: number }>())?.version, 1);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
