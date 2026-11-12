import assert from "node:assert/strict";
import test from "node:test";
import { CompiledQuery } from "kysely";
import { D1ReadSet } from "../src/infrastructure/database/d1/D1ReadSet.ts";
import { createD1TestRuntime } from "./support/d1Runtime.ts";

import { assertD1StatementLimits } from "./support/d1StatementLimits.ts";

test("D1 read guards support 100 columns without exceeding the SQL function argument limit", async () => {
  const { runtime, database, binding } = await createD1TestRuntime();
  try {
    const query = CompiledQuery.raw(`SELECT ${Array.from({ length: 100 }, (_, i) => `${i % 3 === 0 ? "NULL" : i} AS column_${i}`).join(", ")}`);
    const reads = new D1ReadSet();
    await reads.execute(query, () => database.executeQuery(query));
    for (const guard of reads.guards) {
      assertD1StatementLimits(guard);
      assert.ok(await binding.prepare(guard.sql).bind(...guard.parameters).first());
    }
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 read guards preserve large multirow results and escaped text without oversized string bindings", async () => {
  const { runtime, database, binding } = await createD1TestRuntime();
  try {
    await binding.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, body TEXT, note TEXT)");
    const body = "x".repeat(12_000);
    await binding.batch(Array.from({ length: 200 }, (_, id) => binding.prepare("INSERT INTO sample VALUES (?, ?, NULL)").bind(id, body)));
    for (const query of [CompiledQuery.raw("SELECT * FROM sample ORDER BY id"), CompiledQuery.raw("SELECT ? AS body, NULL AS note", ["\n".repeat(1_100_000)])]) {
      const reads = new D1ReadSet();
      await reads.execute(query, () => database.executeQuery(query));
      for (const guard of reads.guards) {
        assertD1StatementLimits(guard);
        assert.ok(await binding.prepare(guard.sql).bind(...guard.parameters).first());
      }
      if (query.sql.includes("sample")) {
        await binding.prepare("UPDATE sample SET note = 'changed' WHERE id = 199").run();
        const results = await binding.batch(reads.guards.map((guard) => binding.prepare(guard.sql).bind(...guard.parameters)));
        assert.ok(results.some(({ results }) => !results.length));
        await binding.prepare("UPDATE sample SET note = NULL WHERE id = 199").run();
        await binding.prepare("INSERT INTO sample VALUES (200, ?, NULL)").bind(body).run();
        const added = await binding.batch(reads.guards.map((guard) => binding.prepare(guard.sql).bind(...guard.parameters)));
        assert.ok(added.some(({ results }) => !results.length), "added rows must invalidate a chunked snapshot");
      }
    }
  } finally { await database.destroy(); await runtime.dispose(); }
});
