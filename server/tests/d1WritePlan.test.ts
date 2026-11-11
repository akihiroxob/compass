import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { D1WritePlan } from "../src/infrastructure/database/d1/D1WritePlan.ts";
import { D1PreconditionFailedError } from "../src/infrastructure/database/d1/D1AtomicBatch.ts";

test("D1 planned read sets prevent write skew across different rows and preserve SQL scalar values", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  const a = new D1WritePlan(binding, { task: { key: ["id"] } }), b = new D1WritePlan(binding, { task: { key: ["id"] } });
  try {
    await initializeD1TestSchema(binding);
    const { projectRepository } = createD1OrganizationInfrastructure(database, binding, activityActorContext);
    const project = await projectRepository.create({ name: "Product", mission: "Goal", description: null, vision: null,
      principles: [], constraints: [], repositories: [], resources: [] });
    for (const id of ["first", "second"]) await database.insertInto("task").values({ id, project_id: project.id, story_id: null,
      title: "O'Brien\n日本語\t", description: null, status: "todo", assignee: null, reject_reason: null, resume_source_status: null,
      sort_order: 1, created_at: 1000, updated_at: 1000, task_key: null }).execute();
    for (const plan of [a, b]) {
      const existing = await plan.database.selectFrom("task").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("project_id", "=", project.id).where("status", "=", "doing").executeTakeFirstOrThrow();
      assert.equal(existing.count, 0);
      const values = await plan.database.selectFrom("task").select([sql<string>`title`.as("odd'\"key"), "description", "sort_order"])
        .where("id", "=", "first").executeTakeFirstOrThrow();
      assert.equal(values["odd'\"key"], "O'Brien\n日本語\t");
      assert.equal(values.description, null);
      assert.equal(values.sort_order, 1);
    }
    await a.update("task", { id: "first" }, { status: "doing" });
    await b.update("task", { id: "second" }, { status: "doing" });
    await a.commit();
    await assert.rejects(b.commit(), D1PreconditionFailedError);
    const rows = await database.selectFrom("task").select(["id", "status"]).orderBy("id").execute();
    assert.deepEqual(rows, [{ id: "first", status: "doing" }, { id: "second", status: "todo" }]);
  } finally { await Promise.all([a.dispose(), b.dispose()]); await database.destroy(); await runtime.dispose(); }
});
