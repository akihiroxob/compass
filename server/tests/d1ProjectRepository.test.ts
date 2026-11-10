import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { D1ProjectRepository } from "../src/infrastructure/repository/d1/D1ProjectRepository.ts";
import { D1WorkspaceRepository } from "../src/infrastructure/repository/d1/D1WorkspaceRepository.ts";
import { createD1ProjectReferenceChecks, planD1ProjectArchiveActivity } from "../src/infrastructure/repository/d1/projectD1Links.ts";
import { asActivityDatabase, asDirectionDatabase, asOrganizationDatabase } from "../src/infrastructure/database/contextDatabase.ts";

const input = { name: "Project", description: "Purpose", mission: "Mission", vision: "Vision", principles: ["One", "Two"], constraints: ["Bound"],
  repositories: [{ name: "Source", url: "https://github.com/example/source", requiredChecks: ["tests"] }],
  resources: [{ name: "Guide", url: "https://example.test/guide", kind: "document" }] };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    return { ...context, ...createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext, () => 100) };
  } catch (error) {
    await context.runtime.dispose();
    throw error;
  }
};

test("D1 Project creation keeps its Workspace, owner and maximum-sized child collections atomic", async () => {
  const { runtime, database, workspaceRepository, projectRepository } = await setup();
  try {
    await database.insertInto("human_user").values({ id: "owner", display_name: "Owner", email: "owner@example.test",
      platform_role: "owner", status: "active", created_at: 1, updated_at: 1 }).execute();
    const resources = Array.from({ length: 50 }, (_, i) => ({ name: `Resource ${i}`, url: `https://example.test/${i}`, kind: null }));
    const repositories = Array.from({ length: 20 }, (_, i) => ({ name: `Repository ${i}`, url: `https://github.com/example/r${i}`, requiredChecks: ["tests"] }));
    const project = await projectRepository.create({ ...input, resources, repositories }, "owner");
    assert.deepEqual(project.resources.map(({ name }) => name), resources.map(({ name }) => name));
    assert.deepEqual(project.repositories.map(({ requiredChecks }) => requiredChecks), repositories.map(({ requiredChecks }) => requiredChecks));
    assert.deepEqual(project.principles, input.principles);
    assert.equal((await database.selectFrom("workspace_membership").selectAll().executeTakeFirstOrThrow()).workspace_id, project.workspaceId);
    await assert.rejects(projectRepository.create(input, "missing-owner"));
    assert.equal((await workspaceRepository.findAll()).length, 1);
    assert.equal((await projectRepository.findAll()).length, 1);
    const second = await projectRepository.createInWorkspace(project.workspaceId, { ...input, name: "Second" });
    assert.ok(second.kind === "created");
    assert.equal(second.project.workspaceId, project.workspaceId);
    assert.equal((await database.selectFrom("workspace_membership").selectAll().execute()).length, 1);
    await workspaceRepository.archive(project.workspaceId, "done");
    assert.deepEqual(await projectRepository.createInWorkspace(project.workspaceId, input), { kind: "workspace_archived" });
    assert.deepEqual(await projectRepository.createInWorkspace("missing", input), { kind: "not_found" });
    assert.equal((await projectRepository.findAllInWorkspace(project.workspaceId)).length, 2);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 Project edit preserves retained link identity and rejects a repository reference added before commit", async () => {
  const { runtime, binding, database, projectRepository } = await setup();
  try {
    const project = await projectRepository.create(input);
    const repository = project.repositories[0]!;
    const resource = project.resources[0]!;
    const update = await projectRepository.update(project.id, { expectedUpdatedAt: project.updatedAt,
      repositories: [{ id: repository.id, name: "Renamed", url: repository.url }],
      resources: [{ id: resource.id, name: "New title", url: resource.url, kind: resource.kind }] });
    assert.ok(update.kind === "updated");
    assert.deepEqual(update.project.repositories, [{ ...repository, name: "Renamed" }]);
    assert.equal(update.project.resources[0]?.id, resource.id);
    assert.deepEqual(await projectRepository.update(project.id, { expectedUpdatedAt: project.updatedAt, name: "Old editor" }), { kind: "stale" });
    await database.insertInto("intent").values({ id: "intent", workspace_id: project.workspaceId, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    await database.insertInto("direction_decision").values({ id: "decision", workspace_id: project.workspaceId, intent_id: "intent", outcome_id: null,
      type: "adr_candidate", judgment: "decide", reason: "reason", options: "[]", intent_version: 1, intent_brief_snapshot: "{}", principal_id: "agent",
      run_ref: "run", request_key: "decision", input_hash: "hash", evaluation_id: null, created_at: 1 }).execute();
    const references = createD1ProjectReferenceChecks(asDirectionDatabase(database));
    let inserted = false;
    const organization = asOrganizationDatabase(database);
    const racing = new D1ProjectRepository(organization, binding, new D1WorkspaceRepository(organization, binding), {
      ...references,
      findReferenced: async (ids) => {
        const found = await references.findReferenced(ids);
        if (!inserted) {
          await database.insertInto("adr_handoff_request").values({ id: "handoff", workspace_id: project.workspaceId, project_id: project.id,
            decision_id: "decision", repository_id: repository.id, correlation_id: "correlation", request_key: "handoff", input_hash: "hash",
            payload: "{}", principal_id: "agent", created_at: 1 }).execute();
          inserted = true;
        }
        return found;
      },
    }, planD1ProjectArchiveActivity(asActivityDatabase(database), activityActorContext));
    assert.deepEqual(await racing.update(project.id, { name: "Must not save", repositories: [] }),
      { kind: "repository_referenced", repositoryId: repository.id, repositoryName: "Renamed" });
    assert.deepEqual(await projectRepository.findDetailById(project.id), update.project);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 Project archive rolls back if Activity append fails and writes one canonical Activity under concurrency", async () => {
  const { runtime, binding, database, projectRepository, workspaceRepository } = await setup();
  try {
    const project = await projectRepository.create(input);
    await binding.prepare("CREATE TRIGGER reject_archive BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'test activity failure'); END;").run();
    await assert.rejects(projectRepository.archive(project.id, "failure"), /test activity failure/);
    assert.equal((await projectRepository.findById(project.id))?.status, "active");
    await binding.prepare("DROP TRIGGER reject_archive").run();
    const results = await activityActorContext.run({ principalId: "human:operator", role: "operator" }, () => Promise.all([
      projectRepository.archive(project.id, "one"), projectRepository.archive(project.id, "two"),
    ]));
    assert.deepEqual(results.map(({ kind }) => kind).sort(), ["already_archived", "archived"]);
    const activities = await database.selectFrom("activity").selectAll().execute();
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.type, "project.archived");
    assert.equal(activities[0]?.principal_id, "human:operator");
    assert.equal(activities[0]?.project_id, project.id);
    assert.equal((await workspaceRepository.findById(project.workspaceId))?.status, "active");
    assert.deepEqual(await projectRepository.update(project.id, { name: "Forbidden" }), { kind: "project_archived" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
