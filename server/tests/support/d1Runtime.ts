import { enforceD1StatementLimits } from "./d1StatementLimits.ts";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { readFile } from "node:fs/promises";
import { createD1Database } from "../../src/infrastructure/database/d1/D1Dialect.ts";

export const createD1TestRuntime = async () => {
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
  const binding = enforceD1StatementLimits(await runtime.getD1Database("DB") as unknown as D1Database);
  const database = createD1Database(binding);
  return { runtime, binding, database };
};


export const initializeD1TestSchema = async (binding: D1Database) => {
  const schema = await readFile(new URL("../../../database/migrations/0001_initial_schema.sql", import.meta.url), "utf8");
  await binding.batch(schema.split(";").filter((statement) => statement.trim()).map((statement) => binding.prepare(statement)));
  await binding.prepare(await readFile(new URL("../../../database/d1/migrations/0000_d1_atomic_guards.sql", import.meta.url), "utf8")).run();
};
