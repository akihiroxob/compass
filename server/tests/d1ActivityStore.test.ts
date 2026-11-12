import assert from "node:assert/strict";
import test from "node:test";
import { ActivityScope, RecordActivityUseCase } from "@compass/activity";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { createD1ActivityInfrastructure } from "../src/bootstrap/d1ActivityInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";

test("D1 Activity handles concurrent replays, corrections and rollback with existing Application rules", async () => {
  const { runtime, database, binding } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const { projectRepository } = createD1OrganizationInfrastructure(database, binding, activityActorContext);
    const project = await projectRepository.create({ name: "Product", mission: "Goal", description: null, vision: null,
      principles: [], constraints: [], repositories: [], resources: [] });
    const { store, unitOfWork } = createD1ActivityInfrastructure(binding);
    const useCase = new RecordActivityUseCase(ActivityScope.PROJECT, {
      resolveActor: async () => ({ principalId: "worker", role: "worker" }),
      requireReader: async () => "worker",
    }, unitOfWork, () => 1000);
    const input = { projectId: project.id, requestId: "record", type: "investigation.completed", summary: "結果", body: "O'Brien\n日本語", refs: [] };
    const results = await Promise.all([useCase.execute("worker", input), useCase.execute("worker", input)]);
    assert.equal(results[0]!.activity.id, results[1]!.activity.id);
    assert.equal(results.filter(({ created }) => created).length, 1);
    await assert.rejects(useCase.execute("worker", { ...input, summary: "changed" }), /already used/);
    const original = results[0]!.activity;
    const correction = await useCase.execute("worker", { ...input, requestId: "correction", correctsActivityId: original.id, summary: "訂正" });
    assert.equal((await store.listCorrections(original.id))[0]?.id, correction.activity.id);
    await assert.rejects(unitOfWork.execute(async (planned) => {
      await planned.append({ ...original, id: "rolled-back", dedupeKey: "rollback", inputHash: "hash" });
      assert.equal((await planned.find("rolled-back"))?.id, "rolled-back");
      assert.equal(await store.find("rolled-back"), null);
      throw new Error("abort");
    }), /abort/);
    assert.equal(await store.findByDedupeKey("rollback"), null);
    const page = await store.listWorkspaceStream(project.workspaceId, { limit: 20 });
    assert.ok(page.activities.some(({ id }) => id === original.id));
    const longText = `AbC%_\\${"日本語".repeat(20)}`;
    await useCase.execute("worker", { ...input, requestId: "long-search", summary: "Long investigation", body: longText });
    const found = await store.listWorkspaceStream(project.workspaceId, { limit: 20, text: longText.replace("AbC", "abc") });
    assert.equal(found.activities.length, 1);
    assert.equal(found.activities[0]?.summary, "Long investigation");
    assert.equal((await store.listWorkspaceStream(project.workspaceId, { limit: 20, text: `${longText}missing` })).activities.length, 0);
    await projectRepository.archive(project.id, "Completed");
    assert.equal((await useCase.execute("worker", input)).activity.id, original.id);
    await assert.rejects(useCase.execute("worker", { ...input, requestId: "after-archive" }), /archived/);
  } finally { await database.destroy(); await runtime.dispose(); }
});
