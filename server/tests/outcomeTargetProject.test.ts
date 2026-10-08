import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";
import {
  DirectionReferenceLookupService,
  SQLiteOutcomeRepository,
  SQLiteOutcomeTargetProjectRepository,
} from "@compass/direction";
import { KyselyWorkStore, TaskCoordinationService, type DirectionReferenceLookupPort } from "@compass/work";
import {
  CreateWorkspaceProjectUseCase,
  CreateWorkspaceUseCase,
  SQLiteProjectRepository,
  SQLiteWorkspaceRepository,
} from "@compass/organization";
import type { createApp } from "../src/bootstrap/app.ts";
import { asDirectionDatabase, asOrganizationDatabase, asWorkDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import {
  directionProjectReaders,
  directionWorkspaceReaders,
  projectRepositoryReferenceFinder,
  workExternalReaders,
} from "../src/infrastructure/repository/contextAdapters.ts";
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
  const workspace = await createWorkspace.execute({ name: "Workspace", mission: "Mission", constraints: ["Keep the public API"] });
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

const callTool = async (app: App, name: string, args: object, principal?: string, activeRole?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
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

test("Strategist Context: active Project summaries (purpose and references only) and current Targets are the Target decision input", async () => {
  const { database, services, workspace, intent, outcome, a, b, c } = await setup();
  try {
    await services.updateProjectUseCase.execute(a.id, {
      description: "Consumer app",
      repositories: [{ name: "app", url: "https://example.com/app.git" }],
      resources: [{ name: "spec", url: "https://example.com/spec", kind: "docs" }],
    });
    await services.archiveProjectUseCase.execute(c.id, { reason: "Retired" });
    const cancelled = await services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, cancelled.id, b.id);
    await services.cancelOutcomeUseCase.execute(workspace.id, intent.id, cancelled.id, { reason: "Replan" });
    await seedWorkspaceGrant(database, workspace.id, "strategist-agent", "strategist");
    await seedWorkspaceGrant(database, workspace.id, "researcher-agent", "researcher");
    const app = await createSignedInApp(database, services);

    const empty = (await callTool(app, "get_strategist_context", { workspaceId: workspace.id }, "strategist-agent")).structuredContent;
    // archivedのProject・別WorkspaceのProjectは選択肢に含めない。Resourceは参照（名前・URL・種類）だけ。
    assert.deepEqual(empty.projects.map((project: { id: string }) => project.id), [a.id, b.id]);
    const summary = empty.projects[0];
    assert.deepEqual(Object.keys(summary).sort(), ["description", "id", "name", "repositories", "resources"]);
    assert.equal(summary.description, "Consumer app");
    assert.deepEqual(summary.repositories.map((item: { name: string; url: string }) => [item.name, item.url]), [["app", "https://example.com/app.git"]]);
    assert.deepEqual(Object.keys(summary.resources[0]).sort(), ["id", "kind", "name", "url"]);
    // Targetなしの有効なOutcomeと、取消済みOutcomeのTargetを区別できる。
    assert.deepEqual(empty.outcomeTargets.map((target: { outcomeId: string; projectId: string }) => [target.outcomeId, target.projectId]), [[cancelled.id, b.id]]);

    const added = await callTool(app, "set_outcome_target", { workspaceId: workspace.id, outcomeId: outcome.id, projectId: a.id }, "strategist-agent");
    assert.equal(added.isError, undefined);
    await services.archiveProjectUseCase.execute(a.id, { reason: "Moved" });
    const after = (await callTool(app, "get_strategist_context", { workspaceId: workspace.id }, "strategist-agent")).structuredContent;
    assert.deepEqual(after.projects.map((project: { id: string }) => project.id), [b.id]);
    assert.deepEqual(
      after.outcomeTargets
        .filter((target: { outcomeId: string }) => target.outcomeId === outcome.id)
        .map((target: { projectId: string; projectStatus: string }) => [target.projectId, target.projectStatus]),
      [[a.id, "archived"]],
    );

    assert.equal((await callTool(app, "get_strategist_context", { workspaceId: workspace.id }, "researcher-agent")).structuredContent.error.code, "FORBIDDEN");
  } finally {
    await database.destroy();
  }
});

const storiesOf = async (app: App, projectId: string, principal: string) =>
  (await callTool(app, "list_stories", { projectId }, principal)).structuredContent.stories as Record<string, any>[];

test("Story handoff: one Outcome yields a Story per Target Project; non-Target and other-Workspace Projects are rejected; Work stays Project-scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-target-handoff-"));
  const path = join(directory, "compass.db");
  try {
    const { database, services, workspace, outcome, a, b, c, foreign } = await setup(path);
    const app = await createSignedInApp(database, services);
    for (const [project, principal] of [[a, "manager-a"], [b, "manager-b"], [c, "manager-c"], [foreign, "manager-f"]] as const) {
      await seedProjectGrant(database, project.id, principal, "manager");
    }
    await seedProjectGrant(database, a.id, "worker-a", "worker");
    await services.updateProjectUseCase.execute(a.id, { repositories: [{ name: "app", url: "https://example.com/app.git" }] });
    await services.updateProjectUseCase.execute(b.id, { repositories: [{ name: "api", url: "https://example.com/api.git" }] });
    const repositoryA = (await services.getProjectUseCase.execute(a.id)).repositories[0]!;
    const repositoryB = (await services.getProjectUseCase.execute(b.id)).repositories[0]!;
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id);
    const handoff = (projectId: string, principal: string, extra: object = {}) =>
      callTool(app, "issue_story", { projectId, title: "Deliver", outcomeId: outcome.id, requestId: `${principal}-${JSON.stringify(extra)}`, ...extra }, principal);

    // Target A / Bには、同じOutcomeから別々のStoryを作れる。ConstraintsはWorkspace、RepositoryはそのProjectから取る。
    const storyA = (await handoff(a.id, "manager-a", { repositoryId: repositoryA.id })).structuredContent;
    const storyB = (await handoff(b.id, "manager-b", { repositoryId: repositoryB.id })).structuredContent;
    assert.notEqual(storyA.id, storyB.id);
    for (const [story, project, repository] of [[storyA, a, repositoryA], [storyB, b, repositoryB]] as const) {
      assert.equal(story.projectId, project.id);
      assert.equal(story.outcomeId, outcome.id);
      assert.equal(story.correlationId, `outcome:${outcome.id}`);
      assert.deepEqual(story.constraints, ["Keep the public API"]);
      assert.deepEqual(story.repository, { id: repository.id, name: repository.name, url: repository.url });
    }
    // 別ProjectのRepositoryは参照できない。
    assert.equal((await handoff(a.id, "manager-a", { repositoryId: repositoryB.id, correlationId: "other" })).structuredContent.error.code, "NOT_FOUND");

    // 同じWorkspaceでもTargetでないProjectはCONFLICT、別WorkspaceのProjectにはOutcomeが見えない（NOT_FOUND）。
    const notTarget = (await handoff(c.id, "manager-c")).structuredContent.error;
    assert.equal(notTarget.code, "CONFLICT");
    assert.equal(notTarget.reason, "not_target_project");
    assert.equal((await handoff(foreign.id, "manager-f")).structuredContent.error.code, "NOT_FOUND");
    assert.deepEqual(await storiesOf(app, c.id, "manager-c"), []);
    assert.deepEqual(await storiesOf(app, foreign.id, "manager-f"), []);

    // Work（Story / Task / Claim / Change）はProject単位のまま。他ProjectのGrantでは読めず、操作できない。
    const taskB = (await callTool(app, "issue_task", { projectId: b.id, storyId: storyB.id, title: "API", taskKey: "api", requestId: "task-b" }, "manager-b")).structuredContent;
    assert.deepEqual((await storiesOf(app, a.id, "manager-a")).map((story) => story.id), [storyA.id]);
    assert.equal((await callTool(app, "list_stories", { projectId: b.id }, "manager-a")).structuredContent.error.code, "FORBIDDEN");
    assert.equal((await callTool(app, "list_tasks", { projectId: b.id }, "worker-a")).structuredContent.error.code, "FORBIDDEN");
    assert.equal((await callTool(app, "claim_task", { taskId: taskB.id, requestId: "claim-b" }, "worker-a")).structuredContent.error.code, "FORBIDDEN");
    const changesA = (await callTool(app, "list_changes", { projectId: a.id }, "manager-a")).structuredContent.changes as { entityId: string }[];
    assert.deepEqual(changesA.map((change) => change.entityId), [storyA.id]);

    // Target解除後は新しいhandoffを拒否するが、作成済みStoryの再送は元のStoryを返す。
    await services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    assert.equal((await handoff(a.id, "manager-a", { repositoryId: repositoryA.id, requestId: "replay" })).structuredContent.id, storyA.id);
    assert.equal((await handoff(a.id, "manager-a", { correlationId: "again" })).structuredContent.error.reason, "not_target_project");
    await database.destroy();

    // 同じschemaで再起動しても、Project別のStoryが残る。
    const reopened = createDatabase(path);
    try {
      await initializeSchema(reopened);
      const reopenedServices = createApplicationServices(reopened);
      const reopenedApp = await createSignedInApp(reopened, reopenedServices);
      assert.deepEqual((await storiesOf(reopenedApp, a.id, "manager-a")).map((story) => story.id), [storyA.id]);
      assert.deepEqual((await storiesOf(reopenedApp, b.id, "manager-b")).map((story) => story.id), [storyB.id]);
    } finally {
      await reopened.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Story handoff: a Target removed after the Outcome snapshot and before the Story is saved rejects the new Story; replays still return the created Story", async () => {
  const { database, services, workspace, outcome, a, b } = await setup();
  try {
    await seedProjectGrant(database, a.id, "manager-a", "manager");
    await seedProjectGrant(database, b.id, "manager-b", "manager");
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id);
    const direction = asDirectionDatabase(database);
    const lookup = new DirectionReferenceLookupService(
      new SQLiteProjectRepository(asOrganizationDatabase(database), projectRepositoryReferenceFinder),
      new SQLiteOutcomeRepository(direction, directionWorkspaceReaders),
      new SQLiteOutcomeTargetProjectRepository(direction, directionProjectReaders, directionWorkspaceReaders),
    );
    // Story処理がTargetを含むsnapshotを取得した直後、保存transactionの前に、別操作のTarget解除をcommitさせる。
    let unsetAfterSnapshot: string | null = null;
    const racingLookup: DirectionReferenceLookupPort = {
      getProjectExecutionContext: (projectId) => lookup.getProjectExecutionContext(projectId),
      getOutcomeSnapshot: async (workspaceId, outcomeId) => {
        const snapshot = await lookup.getOutcomeSnapshot(workspaceId, outcomeId);
        if (unsetAfterSnapshot !== null) {
          await services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, unsetAfterSnapshot);
          unsetAfterSnapshot = null;
        }
        return snapshot;
      },
    };
    const coordination = new TaskCoordinationService(new KyselyWorkStore(asWorkDatabase(database), workExternalReaders), racingLookup);
    const input = (projectId: string) => ({ projectId, title: "Deliver", outcomeId: outcome.id });

    const created = await coordination.issueStory("manager-a", input(a.id), "story-a");
    unsetAfterSnapshot = b.id;
    await assert.rejects(coordination.issueStory("manager-b", input(b.id), "story-b"), {
      code: "CONFLICT",
      details: { reason: "not_target_project" },
    });
    assert.equal(unsetAfterSnapshot, null);
    assert.deepEqual(await services.listOutcomeTargetProjectsUseCase.execute(workspace.id, outcome.id).then((targets) => targets.map((target) => target.projectId)), [a.id]);
    assert.deepEqual(await database.selectFrom("story").select("id").where("project_id", "=", b.id).execute(), []);

    // 作成済みStoryの再送は、Target解除後も元のStoryを返す（同じrequestId・同じ相関ID）。
    await services.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    assert.equal((await coordination.issueStory("manager-a", input(a.id), "story-a")).id, created.id);
    assert.equal((await coordination.issueStory("manager-a", input(a.id), "story-a-again")).id, created.id);
    assert.deepEqual((await database.selectFrom("story").select("id").where("project_id", "=", a.id).execute()).map((row) => row.id), [created.id]);
  } finally {
    await database.destroy();
  }
});

test("Manager handoff: a Project manager Grant alone (activeRole=manager) reads the Outcome through the Project and hands it off to Target A / B", async () => {
  const { database, services, workspace, intent, outcome, a, b, c, foreign } = await setup();
  try {
    const app = await createSignedInApp(database, services);
    for (const [project, principal] of [[a, "manager-a"], [b, "manager-b"], [c, "manager-c"], [foreign, "manager-f"]] as const) {
      await seedProjectGrant(database, project.id, principal, "manager");
    }
    await seedProjectGrant(database, a.id, "worker-a", "worker");
    await services.updateProjectUseCase.execute(a.id, { repositories: [{ name: "app", url: "https://example.com/app.git" }] });
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, a.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id);
    const asManager = (name: string, args: object, principal: string) => callTool(app, name, args, principal, "manager");

    // Workspace Direction Grantは継承しない。Workspace scopeの`get_outcome`はProject manager Grantでは読めないまま。
    const workspaceRead = await asManager("get_outcome", { workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id }, "manager-a");
    assert.equal(workspaceRead.structuredContent.error.code, "FORBIDDEN");

    for (const [project, principal] of [[a, "manager-a"], [b, "manager-b"]] as const) {
      // Roleの手順: handoff Contextで本文・成功条件・Constraints・Repositoryを読み、再開に備えて既存Storyを確認してから起票する。
      const context = (await asManager("get_outcome_handoff_context", { projectId: project.id, outcomeId: outcome.id }, principal)).structuredContent;
      assert.equal(context.error, undefined);
      assert.equal(context.projectId, project.id);
      assert.equal(context.workspaceId, workspace.id);
      assert.equal(context.correlationId, `outcome:${outcome.id}`);
      assert.deepEqual(
        [context.outcome.id, context.outcome.intentId, context.outcome.title, context.outcome.description, context.outcome.status],
        [outcome.id, intent.id, outcomeInput.title, outcomeInput.description, "active"],
      );
      assert.deepEqual(context.outcome.successCriteria.map((criterion: { description: string }) => criterion.description), ["Done"]);
      assert.deepEqual(context.constraints, ["Keep the public API"]);
      assert.deepEqual(
        (await asManager("list_stories", { projectId: project.id }, principal)).structuredContent.stories.filter(
          (story: { correlationId: string | null }) => story.correlationId === context.correlationId,
        ),
        [],
      );
      const story = (
        await asManager(
          "issue_story",
          {
            projectId: project.id,
            title: context.outcome.title,
            description: context.outcome.description,
            outcomeId: context.outcome.id,
            ...(context.repositories.length > 0 ? { repositoryId: context.repositories[0].id } : {}),
            requestId: `handoff-${principal}`,
          },
          principal,
        )
      ).structuredContent;
      assert.equal(story.error, undefined);
      assert.equal(story.projectId, project.id);
      assert.equal(story.correlationId, context.correlationId);
      assert.deepEqual(story.successCriteria.map((criterion: { id: string }) => criterion.id), context.outcome.successCriteria.map((criterion: { id: string }) => criterion.id));
      const task = await asManager("issue_task", { projectId: project.id, storyId: story.id, title: "Deliver", taskKey: "criterion-1", requestId: `task-${principal}` }, principal);
      assert.equal(task.structuredContent.storyId, story.id);
    }
    assert.equal((await asManager("get_outcome_handoff_context", { projectId: a.id, outcomeId: outcome.id }, "manager-a")).structuredContent.repositories.length, 1);

    // Target外は`not_target_project`、別WorkspaceのProjectからはOutcomeが見えない。Manager以外・他ProjectのGrantは拒否する。
    const notTarget = (await asManager("get_outcome_handoff_context", { projectId: c.id, outcomeId: outcome.id }, "manager-c")).structuredContent.error;
    assert.deepEqual([notTarget.code, notTarget.reason], ["CONFLICT", "not_target_project"]);
    assert.equal((await asManager("get_outcome_handoff_context", { projectId: foreign.id, outcomeId: outcome.id }, "manager-f")).structuredContent.error.code, "NOT_FOUND");
    assert.equal((await asManager("get_outcome_handoff_context", { projectId: a.id, outcomeId: outcome.id }, "manager-b")).structuredContent.error.code, "FORBIDDEN");
    assert.equal((await callTool(app, "get_outcome_handoff_context", { projectId: a.id, outcomeId: outcome.id }, "worker-a", "worker")).structuredContent.error.code, "FORBIDDEN");
    assert.equal((await callTool(app, "get_outcome_handoff_context", { projectId: a.id, outcomeId: outcome.id })).structuredContent.error.code, "UNAUTHENTICATED");

    // 取消済みOutcomeは状態を確認できるが、新しいStoryは作れない。
    await services.cancelOutcomeUseCase.execute(workspace.id, intent.id, outcome.id, { reason: "Replan" });
    const cancelled = (await asManager("get_outcome_handoff_context", { projectId: a.id, outcomeId: outcome.id }, "manager-a")).structuredContent;
    assert.equal(cancelled.outcome.status, "cancelled");
    const rejected = await asManager("issue_story", { projectId: a.id, title: "Again", outcomeId: outcome.id, correlationId: "again", requestId: "again" }, "manager-a");
    assert.equal(rejected.structuredContent.error.code, "CONFLICT");
  } finally {
    await database.destroy();
  }
});
