import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1OutcomeTargetProjectRepository } from "../src/infrastructure/repository/d1/D1OutcomeTargetProjectRepository.ts";

test("D1 Outcome Targets enforce scope and state, serialize duplicate changes and read Project status", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const { workspaceRepository, projectRepository } = createD1OrganizationInfrastructure(database, binding, activityActorContext);
    const workspace = await workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    const other = await workspaceRepository.create({ name: "Other", mission: "Other", vision: null, principles: [], constraints: [] });
    const input = { name: "Product", description: null, repositories: [], resources: [] };
    const first = await projectRepository.createInWorkspace(workspace.id, input);
    const second = await projectRepository.createInWorkspace(workspace.id, input);
    const foreign = await projectRepository.createInWorkspace(other.id, input);
    assert.ok(first.kind === "created" && second.kind === "created" && foreign.kind === "created");
    await database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    for (const id of ["outcome", "empty"]) {
      await database.insertInto("outcome").values({ id, workspace_id: workspace.id, intent_id: "intent", intent_version: 1,
        title: id, description: "Description", rationale: "Reason", status: "active", revision: 1, created_at: 1, updated_at: 1 }).execute();
    }
    let time = 10;
    const repository = new D1OutcomeTargetProjectRepository(asDirectionDatabase(database), binding, () => time++);
    assert.equal(await repository.listByOutcome(other.id, "outcome"), null);
    assert.deepEqual(await repository.listByOutcome(workspace.id, "empty"), []);
    assert.deepEqual(await repository.add(workspace.id, "outcome", foreign.project.id), { kind: "project_not_found" });
    assert.deepEqual(await repository.add(other.id, "outcome", foreign.project.id), { kind: "outcome_not_found" });
    const additions = await Promise.all([repository.add(workspace.id, "outcome", first.project.id), repository.add(workspace.id, "outcome", first.project.id)]);
    assert.deepEqual(additions.map(({ kind }) => kind).sort(), ["added", "already_target"]);
    await repository.add(workspace.id, "outcome", second.project.id);
    assert.deepEqual((await repository.listByWorkspace(workspace.id)).map(({ projectId }) => projectId), [first.project.id, second.project.id]);
    assert.deepEqual(await repository.listByIntent(workspace.id, "intent"), await repository.listByOutcome(workspace.id, "outcome"));
    assert.deepEqual(await repository.listByIntent(workspace.id, "other"), []);
    await projectRepository.archive(first.project.id, "done");
    assert.equal((await repository.listByOutcome(workspace.id, "outcome"))?.[0]?.projectStatus, "archived");
    assert.deepEqual(await repository.add(workspace.id, "outcome", first.project.id), { kind: "project_archived" });
    const removals = await Promise.all([repository.remove(workspace.id, "outcome", first.project.id), repository.remove(workspace.id, "outcome", first.project.id)]);
    assert.deepEqual(removals.map(({ kind }) => kind).sort(), ["not_target", "removed"]);
    // SQL failure leaves the association available for a later retry.
    await binding.prepare("CREATE TRIGGER reject_target_delete BEFORE DELETE ON outcome_target_project BEGIN SELECT RAISE(ABORT, 'target failure'); END;").run();
    await assert.rejects(repository.remove(workspace.id, "outcome", second.project.id), /target failure/);
    assert.equal((await repository.listByWorkspace(workspace.id)).length, 1);
    await binding.prepare("DROP TRIGGER reject_target_delete").run();
    await database.updateTable("outcome").set({ status: "achieved" }).where("id", "=", "outcome").execute();
    assert.deepEqual(await repository.remove(workspace.id, "outcome", second.project.id), { kind: "outcome_not_active", status: "achieved" });
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.remove(workspace.id, "outcome", second.project.id), { kind: "workspace_archived" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
