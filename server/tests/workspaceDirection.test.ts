import assert from "node:assert/strict";
import test from "node:test";
import { CreateWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";
import { SQLiteIntentRepository, SQLiteOutcomeRepository } from "@compass/direction";
import { CreateWorkspaceProjectUseCase, SQLiteProjectRepository } from "@compass/organization";
import { asDirectionDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { directionWorkspaceReaders, projectRepositoryReferenceFinder } from "../src/infrastructure/repository/contextAdapters.ts";


import { createSignedInApp, seedLegacyProjectGrant } from "./support/humanSession.ts";

const intentInput = { title: "Direction", desiredState: "Shared direction" };
const outcomeInput = { title: "Result", description: "Result", rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }] };

test("Workspace owns Intent/Outcome; active Intent and entity references are isolated by Workspace", async () => {
  const database = createDatabase(":memory:");
  try {
    await initializeSchema(database);
    const services = createApplicationServices(database);
    const createWorkspace = new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database)));
    const a = await createWorkspace.execute({ name: "A", mission: "A" });
    const b = await createWorkspace.execute({ name: "B", mission: "B" });
    const direction = services.workspaceDirection;
    const intent = await direction.createIntentUseCase.execute(a.id, intentInput);
    assert.equal(intent.workspaceId, a.id);
    assert.equal("projectId" in intent, false);
    await assert.rejects(direction.createIntentUseCase.execute(a.id, intentInput), { code: "CONFLICT" });
    await direction.createIntentUseCase.execute(b.id, intentInput);
    await assert.rejects(direction.createOutcomeUseCase.execute(b.id, intent.id, outcomeInput), { code: "NOT_FOUND" });
    const outcome = await direction.createOutcomeUseCase.execute(a.id, intent.id, outcomeInput);
    assert.equal(outcome.workspaceId, a.id);
    assert.equal(outcome.successCriteria.length, 1);
    await assert.rejects(direction.getOutcomeUseCase.execute(b.id, intent.id, outcome.id), { code: "NOT_FOUND" });
    const activity = await database.selectFrom("activity").selectAll().where("workspace_id", "=", a.id).execute();
    assert.equal(activity.length, 2);
    assert.ok(activity.every(row => row.project_id === null));
  } finally {
    await database.destroy();
  }
});

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute({ name: "Workspace", mission: "Mission" });
  return { database, services, workspace, direction: services.workspaceDirection };
};

test("new schema has Workspace ownership columns, composite FK and Workspace active uniqueness", async () => {
  const { database, direction, workspace } = await setup();
  try {
    for (const table of ["intent", "outcome"]) {
      const columns = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(database);
      assert.ok(columns.rows.some(row => row.name === "workspace_id"));
      assert.ok(!columns.rows.some(row => row.name === "project_id"));
    }
    const intent = await direction.createIntentUseCase.execute(workspace.id, intentInput);
    const b = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute({ name: "B", mission: "B" });
    await assert.rejects(sql`insert into outcome (id, workspace_id, intent_id, title, description, rationale, status, created_at, updated_at)
      values ('cross-workspace', ${b.id}, ${intent.id}, 'T', 'D', 'R', 'active', 1, 1)`.execute(database), /FOREIGN KEY/);
    await assert.rejects(sql`insert into intent (id, workspace_id, title, desired_state, status, created_at, updated_at)
      values ('duplicate', ${workspace.id}, 'T', 'D', 'active', 1, 1)`.execute(database), /UNIQUE/);
    await assert.rejects(sql`insert into intent (id, workspace_id, title, desired_state, status, created_at, updated_at)
      values ('missing', 'missing-workspace', 'T', 'D', 'active', 1, 1)`.execute(database), /FOREIGN KEY/);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally { await database.destroy(); }
});

test("multiple Projects share one Workspace Intent; old Project Direction entry points reject shared ownership", async () => {
  const { database, services, workspace, direction } = await setup();
  try {
    const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(asOrganizationDatabase(database), projectRepositoryReferenceFinder));
    const a = await createProject.execute(workspace.id, { name: "A" });
    const b = await createProject.execute(workspace.id, { name: "B" });
    const intent = await direction.createIntentUseCase.execute(workspace.id, intentInput);
    for (const project of [a, b]) {
      await assert.rejects(services.listIntentsUseCase.execute(project.id), { code: "CONFLICT", details: { reason: "workspace_direction_required" } });
      await assert.rejects(services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput), { code: "CONFLICT" });
    }
    await assert.rejects(services.listIntentsUseCase.execute(workspace.id), { code: "NOT_FOUND" });
    await assert.rejects(direction.listIntentsUseCase.execute(a.id), { code: "NOT_FOUND" });
    assert.equal((await direction.listIntentsUseCase.execute(workspace.id)).length, 1);
    const outcome = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
    assert.equal(outcome.workspaceId, workspace.id);
    const events = await database.selectFrom("runtime_event").selectAll().execute();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.workspace_id, workspace.id);
    assert.equal("project_id" in events[0]!, false);
  } finally { await database.destroy(); }
});

test("Workspace updates preserve fixed success criteria and Intent meaning; abandon cancels its active Outcomes", async () => {
  const { database, workspace, direction } = await setup();
  try {
    const intent = await direction.createIntentUseCase.execute(workspace.id, intentInput);
    const outcome = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
    await assert.rejects(direction.updateIntentUseCase.execute(workspace.id, intent.id, { desiredState: "Different" }), { code: "CONFLICT" });
    await assert.rejects(direction.updateOutcomeUseCase.execute(workspace.id, intent.id, outcome.id, { successCriteria: [] }), { code: "CONFLICT" });
    const changed = await direction.updateOutcomeUseCase.execute(workspace.id, intent.id, outcome.id, { title: "New title" });
    assert.deepEqual(changed.successCriteria, outcome.successCriteria);
    await direction.abandonIntentUseCase.execute(workspace.id, intent.id, { reason: "Replan" });
    assert.equal((await direction.getOutcomeUseCase.execute(workspace.id, intent.id, outcome.id)).status, "cancelled");
    await direction.createIntentUseCase.execute(workspace.id, intentInput);
  } finally { await database.destroy(); }
});

test("Workspace notifications roll back entity and criteria writes if Activity fails, even without any Project", async () => {
  const { database, workspace, direction } = await setup();
  try {
    const intent = await direction.createIntentUseCase.execute(workspace.id, intentInput);
    await sql`create trigger reject_workspace_activity before insert on activity begin select raise(abort, 'activity rejected'); end`.execute(database);
    await assert.rejects(direction.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput), /activity rejected/);
    assert.deepEqual(await database.selectFrom("outcome").selectAll().execute(), []);
    assert.deepEqual(await database.selectFrom("success_criterion").selectAll().execute(), []);
    await assert.rejects(direction.abandonIntentUseCase.execute(workspace.id, intent.id, { reason: "Replan" }), /activity rejected/);
    assert.equal((await direction.getIntentUseCase.execute(workspace.id, intent.id)).status, "active");
    assert.equal((await database.selectFrom("activity").selectAll().execute()).length, 1);
  } finally { await database.destroy(); }
});

test("Workspace archive is guarded by canonical repositories inside the write transaction", async () => {
  const { database, workspace, direction } = await setup();
  try {
    const intent = await direction.createIntentUseCase.execute(workspace.id, intentInput);
    const outcome = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
    await new SQLiteWorkspaceRepository(asOrganizationDatabase(database)).archive(workspace.id, "Done");
    const intents = new SQLiteIntentRepository(asDirectionDatabase(database), directionWorkspaceReaders);
    const outcomes = new SQLiteOutcomeRepository(asDirectionDatabase(database), directionWorkspaceReaders);
    const archived = { kind: "workspace_archived" };
    assert.deepEqual(await intents.create(workspace.id, { ...intentInput, completionDefinition: null }), archived);
    assert.deepEqual(await intents.update(workspace.id, intent.id, { title: "Changed" }), archived);
    assert.deepEqual(await intents.abandon(workspace.id, intent.id, "R"), archived);
    assert.deepEqual(await outcomes.cancel(workspace.id, intent.id, outcome.id, "R"), archived);
    await assert.rejects(direction.updateOutcomeUseCase.execute(workspace.id, intent.id, outcome.id, { title: "Changed" }), { code: "CONFLICT", details: { workspaceStatus: "archived" } });
    assert.deepEqual(await direction.getOutcomeUseCase.execute(workspace.id, intent.id, outcome.id), outcome);
  } finally { await database.destroy(); }
});

test("Workspace Direction and criteria persist after reopening and repeat schema initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-direction-"));
  const path = join(directory, "compass.db");
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const first = await setup(path);
    database = first.database;
    const intent = await first.direction.createIntentUseCase.execute(first.workspace.id, intentInput);
    const outcome = await first.direction.createOutcomeUseCase.execute(first.workspace.id, intent.id, outcomeInput);
    await database.destroy();
    database = createDatabase(path);
    await initializeSchema(database);
    await initializeSchema(database);
    const direction = createApplicationServices(database).workspaceDirection;
    assert.deepEqual(await direction.getIntentUseCase.execute(first.workspace.id, intent.id), intent);
    assert.deepEqual(await direction.getOutcomeUseCase.execute(first.workspace.id, intent.id, outcome.id), outcome);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally {
    await database?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Web/API/MCP keep Project authorization and do not expose shared Workspace Direction", async () => {
  const { database, services, workspace, direction } = await setup();
  try {
    const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(asOrganizationDatabase(database), projectRepositoryReferenceFinder));
    const a = await createProject.execute(workspace.id, { name: "A" });
    const b = await createProject.execute(workspace.id, { name: "B" });
    const intent = await direction.createIntentUseCase.execute(workspace.id, intentInput);
    await direction.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
    const app = await createSignedInApp(database, services);
    const response = await app.request(`/api/projects/${a.id}/intents`);
    assert.equal(response.status, 409);
    const body = await response.json() as { error: { code: string; reason: string } };
    assert.equal(body.error.reason, "workspace_direction_required");
    await seedLegacyProjectGrant(database, a.id, "strategist", "strategist");
    const call = async (projectId: string) => {
      const result = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer strategist", "X-Compass-Active-Role": "strategist" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_strategist_context", arguments: { projectId } } }),
      });
      const data = (await result.text()).split("\n").find(line => line.startsWith("data: "));
      assert.ok(data);
      return JSON.parse(data.slice(6)).result;
    };
    const shared = await call(a.id);
    assert.equal(shared.isError, true);
    assert.equal(shared.structuredContent.error.reason, "workspace_direction_required");
    assert.equal((await call(b.id)).structuredContent.error.code, "FORBIDDEN", "Grantの無いProjectの認可を先に拒否する");
    assert.equal(JSON.stringify(shared).includes(intent.id), false);
  } finally { await database.destroy(); }
});
