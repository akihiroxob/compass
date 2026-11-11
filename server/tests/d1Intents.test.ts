import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asActivityDatabase, asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { planD1DirectionActivity } from "../src/infrastructure/repository/d1/planD1DirectionActivity.ts";
import { D1IntentRepository } from "../src/infrastructure/repository/d1/D1IntentRepository.ts";

const actor = { principalId: "strategist", role: "strategist" };
const input = { title: "Intent", desiredState: "Goal", background: null, audience: null, constraints: null, completionDefinition: null, targetDate: null };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    const repository = new D1IntentRepository(asDirectionDatabase(context.database), context.binding,
      planD1DirectionActivity(asActivityDatabase(context.database), activityActorContext), () => 100);
    return { ...context, ...organization, workspace, repository };
  } catch (error) {
    await context.runtime.dispose();
    throw error;
  }
};

test("D1 Intent creation saves revision and Activity together and rolls back on Activity failure", async () => {
  const { runtime, binding, database, repository, workspace } = await setup();
  try {
    await binding.prepare("CREATE TRIGGER reject_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'activity failure'); END;").run();
    await assert.rejects(repository.create(workspace.id, input, actor), /activity failure/);
    assert.equal((await database.selectFrom("intent").selectAll().execute()).length, 0);
    assert.equal((await database.selectFrom("intent_revision").selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_activity").run();
    const created = await activityActorContext.run(actor, () => repository.create(workspace.id, input, actor));
    assert.ok(created.kind === "created");
    const revisions = await repository.findRevisions(workspace.id, created.intent.id);
    assert.equal(revisions?.length, 1);
    assert.equal(revisions?.[0]?.changedBy, actor.principalId);
    assert.equal((await database.selectFrom("activity").selectAll().executeTakeFirstOrThrow()).principal_id, actor.principalId);
    assert.equal(await repository.findById("other", created.intent.id), null);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 Intent concurrent edits preserve revisions, no-op saves and reasons for semantic changes", async () => {
  const { runtime, database, repository, workspace, workspaceRepository } = await setup();
  try {
    const created = await repository.create(workspace.id, input, actor);
    assert.ok(created.kind === "created");
    const id = created.intent.id;
    const edits = await Promise.all([repository.update(workspace.id, id, { expectedVersion: 1, title: "A" }, actor),
      repository.update(workspace.id, id, { expectedVersion: 1, title: "B" }, actor)]);
    assert.deepEqual(edits.map(({ kind }) => kind).sort(), ["changed", "version_conflict"]);
    const saved = await repository.findById(workspace.id, id);
    assert.equal(saved?.version, 2);
    assert.equal(saved?.meaningVersion, 1);
    await repository.update(workspace.id, id, { expectedVersion: 2, title: saved!.title }, actor);
    assert.deepEqual((await repository.findRevisions(workspace.id, id))?.map(({ version }) => version), [2, 1]);
    await database.insertInto("outcome").values({ id: "outcome", workspace_id: workspace.id, intent_id: id, intent_version: 2,
      title: "Outcome", description: "Description", rationale: "Reason", status: "active", revision: 1, created_at: 1, updated_at: 1 }).execute();
    assert.deepEqual(await repository.update(workspace.id, id, { expectedVersion: 2, desiredState: "New goal" }, actor),
      { kind: "reason_required", fields: ["desiredState"] });
    const changed = await repository.update(workspace.id, id, { expectedVersion: 2, desiredState: "New goal", reason: "New evidence" }, actor);
    assert.ok(changed.kind === "changed");
    assert.equal(changed.intent.meaningVersion, 3);
    const revision = (await repository.findRevisions(workspace.id, id))?.[0];
    assert.equal(revision?.reason, "New evidence");
    assert.equal(revision?.meaningChanged, true);
    assert.equal((await database.selectFrom("outcome").select("intent_version").executeTakeFirstOrThrow()).intent_version, 2);
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.update(workspace.id, id, { expectedVersion: 3, title: "Forbidden" }, actor), { kind: "workspace_archived" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 Intent abandonment atomically cancels active Outcomes and unfinished Research", async () => {
  const { runtime, binding, database, repository, workspace } = await setup();
  try {
    const created = await repository.create(workspace.id, input, actor);
    assert.ok(created.kind === "created");
    const id = created.intent.id;
    for (const status of ["active", "achieved"] as const) {
      await database.insertInto("outcome").values({ id: `outcome-${status}`, workspace_id: workspace.id, intent_id: id, intent_version: 1,
        title: "Outcome", description: "Description", rationale: "Reason", status, revision: 1, created_at: 1, updated_at: 1 }).execute();
    }
    for (const status of ["requested", "completed"] as const) {
      await database.insertInto("research_request").values({ id: `request-${status}`, workspace_id: workspace.id, request_key: status,
        input_hash: "hash", kind: "decision", origin_intent_id: id, origin_outcome_id: null, question: "Question", scope: "Scope",
        completion_condition: "Done", budget_total: 10, budget_used: 0, status, correlation_id: "correlation", created_at: 1, updated_at: 1 }).execute();
    }
    await binding.prepare("CREATE TRIGGER reject_abandon BEFORE INSERT ON activity WHEN NEW.type = 'intent.abandoned' BEGIN SELECT RAISE(ABORT, 'abandon failure'); END;").run();
    await assert.rejects(repository.abandon(workspace.id, id, "reason", 1), /abandon failure/);
    assert.equal((await repository.findById(workspace.id, id))?.status, "active");
    assert.equal((await database.selectFrom("outcome").select("status").where("id", "=", "outcome-active").executeTakeFirstOrThrow()).status, "active");
    assert.equal((await database.selectFrom("research_request").select("status").where("id", "=", "request-requested").executeTakeFirstOrThrow()).status, "requested");
    await binding.prepare("DROP TRIGGER reject_abandon").run();
    assert.equal((await repository.abandon(workspace.id, id, "reason", 1)).kind, "changed");
    assert.equal((await database.selectFrom("outcome").select("status").where("id", "=", "outcome-active").executeTakeFirstOrThrow()).status, "cancelled");
    assert.equal((await database.selectFrom("outcome").select("status").where("id", "=", "outcome-achieved").executeTakeFirstOrThrow()).status, "achieved");
    assert.equal((await database.selectFrom("research_request").select("status").where("id", "=", "request-requested").executeTakeFirstOrThrow()).status, "cancelled");
    assert.equal((await database.selectFrom("research_request").select("status").where("id", "=", "request-completed").executeTakeFirstOrThrow()).status, "completed");
    assert.equal((await database.selectFrom("activity").selectAll().execute()).length, 2);
    assert.equal((await database.selectFrom("runtime_event").selectAll().execute()).length, 0);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
