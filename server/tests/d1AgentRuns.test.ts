import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunStart } from "@compass/access";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1AgentRunRepository } from "../src/infrastructure/repository/d1/D1AgentRunRepository.ts";

test("D1 Agent runs preserve identity and a single terminal result under concurrency", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    let now = 100;
    const repository = new D1AgentRunRepository(asAccessDatabase(database), () => now);
    const input: AgentRunStart = { runId: "run", scope: { kind: "project", id: "project" }, principalId: "worker", role: "worker",
      source: "ralph", provider: "codex", workRef: null, reporter: { kind: "agent", principalId: "worker" }, staleAfterMs: 1000 };
    const starts = await Promise.all([repository.start(input), repository.start(input)]);
    assert.equal(starts.filter((result) => result.kind === "recorded" && result.changed).length, 1);
    assert.equal(starts.filter((result) => result.kind === "recorded" && !result.changed).length, 1);
    const mismatch = await repository.observe({ ...input, principalId: "other" }, 2000);
    assert.equal(mismatch.kind, "identity_mismatch");
    now = 200;
    const observed = await repository.observe(input, 2000);
    assert.ok(observed.kind === "recorded");
    assert.equal(observed.run.staleAt, 2200);
    const finishes = await Promise.all([repository.finish(input, "succeeded", null), repository.finish(input, "failed", "failure")]);
    assert.equal(finishes.filter((result) => result.kind === "recorded" && result.changed).length, 1);
    assert.equal(finishes.filter(({ kind }) => kind === "already_finished").length, 1);
    const winner = finishes.find((result) => result.kind === "recorded" && result.changed);
    assert.ok(winner?.kind === "recorded");
    now = 300;
    assert.deepEqual(await repository.observe(input, 2000), { kind: "recorded", run: winner.run, changed: false });
    assert.deepEqual(await repository.finish(input, winner.run.status as "succeeded" | "failed", "ignored retry"), { kind: "recorded", run: winner.run, changed: false });
    assert.deepEqual(await repository.listLatest([input.scope]), [winner.run]);
    assert.deepEqual(await repository.listByPrincipal([input.scope], "worker", 10), [winner.run]);
    assert.deepEqual(await repository.observe({ ...input, runId: "missing" }, 1000), { kind: "not_found" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
