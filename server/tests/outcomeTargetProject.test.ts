import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";
import {
  CreateWorkspaceProjectUseCase,
  CreateWorkspaceUseCase,
  SQLiteProjectRepository,
  SQLiteWorkspaceRepository,
} from "@compass/organization";
import type { createApp } from "../src/bootstrap/app.ts";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { projectRepositoryReferenceFinder } from "../src/infrastructure/repository/contextAdapters.ts";
import { createSignedInApp, seedWorkspaceGrant } from "./support/humanSession.ts";

type Database = ReturnType<typeof createDatabase>;
type App = ReturnType<typeof createApp>;

const outcomeInput = {
  title: "Result",
  description: "Result",
  rationale: "Reason",
  successCriteria: [{ description: "Done", measurement: "Check" }],
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const organization = asOrganizationDatabase(database);
  const createWorkspace = new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(organization));
  const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(organization, projectRepositoryReferenceFinder));
  const workspace = await createWorkspace.execute({ name: "Workspace", mission: "Mission" });
  const [a, b, c] = [
    await createProject.execute(workspace.id, { name: "A" }),
    await createProject.execute(workspace.id, { name: "B" }),
    await createProject.execute(workspace.id, { name: "C" }),
  ];
  const other = await createWorkspace.execute({ name: "Other", mission: "Other" });
  const foreign = await createProject.execute(other.id, { name: "Foreign" });
  const intent = await services.createIntentUseCase.execute(workspace.id, { title: "Direction", desiredState: "State" });
  const outcome = await services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
  return { database, services, workspace, intent, outcome, a: a!, b: b!, c: c!, other, foreign };
};

test("an Outcome may have no Target; same-Workspace Projects are added once, listed in order and removed", async () => {
  const { database, services, workspace, outcome, a, b } = await setup();
  try {
    assert.deepEqual(await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id), []);
    const first = await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    assert.deepEqual(Object.keys(first).sort(), ["createdAt", "outcomeId", "projectId"]);
    assert.equal(first.projectId, a.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id);
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id), {
      code: "CONFLICT",
      details: { reason: "already_target" },
    });
    const listed = await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id);
    assert.deepEqual(listed.map((target) => [target.projectId, target.projectStatus]), [[a.id, "active"], [b.id, "active"]]);

    const removed = await services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    assert.equal(removed.projectId, a.id);
    await assert.rejects(services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id), { code: "NOT_FOUND" });
    assert.deepEqual((await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id)).map((target) => target.projectId), [b.id]);
  } finally {
    await database.destroy();
  }
});

test("Projects and Outcomes of another Workspace are not found; the table has no extra columns", async () => {
  const { database, services, workspace, outcome, a, other, foreign } = await setup();
  try {
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, foreign.id), { code: "NOT_FOUND" });
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, "missing"), { code: "NOT_FOUND" });
    await assert.rejects(services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, foreign.id), { code: "NOT_FOUND" });
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(other.id, outcome.id, foreign.id), { code: "NOT_FOUND" });
    await assert.rejects(services.listOutcomeTargetProjectsUseCase.execute(other.id, outcome.id), { code: "NOT_FOUND" });
    // Project IDをWorkspace IDとして解釈しない。
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(a.id, outcome.id, a.id), { code: "NOT_FOUND" });
    assert.deepEqual(await database.selectFrom("outcome_target_project").selectAll().execute(), []);

    const columns = await sql<{ name: string }>`select name from pragma_table_info('outcome_target_project')`.execute(database);
    assert.deepEqual(columns.rows.map((row) => row.name).sort(), ["created_at", "outcome_id", "project_id"]);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await assert.rejects(
      sql`insert into outcome_target_project (outcome_id, project_id, created_at) values (${outcome.id}, ${a.id}, 1)`.execute(database),
      /UNIQUE|PRIMARY KEY/,
    );
  } finally {
    await database.destroy();
  }
});

test("Project archive keeps Targets, Stories and Evidence; Strategist removes the archived Target and sets an active Project", async () => {
  const { database, services, workspace, outcome, a, b } = await setup();
  try {
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await database.insertInto("story").values({
      id: "story-a", project_id: a.id, title: "Story", description: null, status: "todo", sort_order: 0,
      created_at: 1, updated_at: 1, outcome_ref: outcome.id, origin_decision_id: null, success_criteria_snapshot: null,
      constraints_snapshot: null, repository_snapshot: null, correlation_id: `outcome:${outcome.id}`,
    }).execute();
    await database.insertInto("outcome_execution_summary").values({
      workspace_id: workspace.id, project_id: a.id, outcome_id: outcome.id, correlation_id: `outcome:${outcome.id}`,
      state: "incomplete", stories: "[]", execution_cursor: 0, observed_cursor: 0, principal_id: "runtime", updated_at: 1,
    }).execute();

    await services.archiveProjectUseCase.execute(a.id, { reason: "Retired" });
    assert.deepEqual(
      (await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id)).map((target) => [target.projectId, target.projectStatus]),
      [[a.id, "archived"]],
    );
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id), {
      code: "CONFLICT",
      details: { projectStatus: "archived" },
    });

    await services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id);
    assert.deepEqual((await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id)).map((target) => target.projectId), [b.id]);
    assert.equal((await database.selectFrom("story").selectAll().where("id", "=", "story-a").executeTakeFirstOrThrow()).outcome_ref, outcome.id);
    assert.equal((await database.selectFrom("outcome_execution_summary").selectAll().execute()).length, 1);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally {
    await database.destroy();
  }
});

test("Targets change only for an active Outcome in an active Workspace; listing stays available", async () => {
  const { database, services, workspace, intent, outcome, a, b } = await setup();
  try {
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await services.cancelOutcomeUseCase.execute(workspace.id, intent.id, outcome.id, { reason: "Replan" });
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id), {
      code: "CONFLICT",
      details: { status: "cancelled" },
    });
    await assert.rejects(services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id), { code: "CONFLICT" });
    assert.equal((await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id)).length, 1);

    const active = await services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
    await new SQLiteWorkspaceRepository(asOrganizationDatabase(database)).archive(workspace.id, "Done");
    await assert.rejects(services.setOutcomeTargetProjectUseCase.execute(workspace.id, active.id, b.id), {
      code: "CONFLICT",
      details: { workspaceStatus: "archived" },
    });
    assert.deepEqual(await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, active.id), []);
  } finally {
    await database.destroy();
  }
});

test("Targets survive a restart on the same schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-target-"));
  const path = join(directory, "compass.db");
  try {
    const { database, services, workspace, outcome, a } = await setup(path);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await database.destroy();

    const reopened = createDatabase(path);
    try {
      await initializeSchema(reopened);
      const listed = await createApplicationServices(reopened).listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id);
      assert.deepEqual(listed.map((target) => target.projectId), [a.id]);
    } finally {
      await reopened.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const callTool = async (app: App, name: string, args: object, principal?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result as { isError?: boolean; structuredContent: Record<string, any> };
};

const seedProjectGrant = (database: Database, projectId: string, principalId: string, role: string) =>
  database.insertInto("project_grant").values({ project_id: projectId, principal_id: principalId, role, created_at: Date.now() }).execute();

test("MCP: a Workspace strategist sets and removes Targets; other Roles are forbidden; Web API lists them", async () => {
  const { database, services, workspace, outcome, a, b } = await setup();
  try {
    const app = await createSignedInApp(database, services);
    await seedWorkspaceGrant(database, workspace.id, "strategist-agent", "strategist");
    await seedWorkspaceGrant(database, workspace.id, "researcher-agent", "researcher");
    await seedProjectGrant(database, a.id, "manager-agent", "manager");
    const input = { workspaceId: workspace.id, outcomeId: outcome.id, projectId: a.id };

    for (const principal of [undefined, "researcher-agent", "manager-agent"]) {
      const denied = await callTool(app, "set_outcome_target", input, principal);
      assert.equal(denied.isError, true);
      assert.match(denied.structuredContent.error.code, /UNAUTHENTICATED|FORBIDDEN/);
    }

    const added = await callTool(app, "set_outcome_target", input, "strategist-agent");
    assert.equal(added.isError, undefined);
    assert.equal(added.structuredContent.target.projectId, a.id);
    const duplicate = await callTool(app, "set_outcome_target", input, "strategist-agent");
    assert.equal(duplicate.structuredContent.error.code, "CONFLICT");
    await callTool(app, "set_outcome_target", { ...input, projectId: b.id }, "strategist-agent");

    const listed = await callTool(app, "list_outcome_targets", { workspaceId: workspace.id, outcomeId: outcome.id }, "strategist-agent");
    assert.deepEqual(listed.structuredContent.targets.map((target: { projectId: string }) => target.projectId), [a.id, b.id]);

    const removed = await callTool(app, "unset_outcome_target", input, "strategist-agent");
    assert.equal(removed.structuredContent.target.projectId, a.id);
    assert.equal((await callTool(app, "unset_outcome_target", input, "researcher-agent")).isError, true);

    const response = await app.request(`/api/workspaces/${workspace.id}/outcomes/${outcome.id}/target-projects`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { targets: { projectId: string; projectStatus: string }[] };
    assert.deepEqual(body.targets.map((target) => [target.projectId, target.projectStatus]), [[b.id, "active"]]);
  } finally {
    await database.destroy();
  }
});
