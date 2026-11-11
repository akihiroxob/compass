import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1ProjectGrantRepository } from "../src/infrastructure/repository/d1/D1ProjectGrantRepository.ts";
import { D1WorkspaceGrantRepository } from "../src/infrastructure/repository/d1/D1WorkspaceGrantRepository.ts";

test("D1 grants preserve duplicate timestamps, scope boundaries and archive guards", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const { workspaceRepository, projectRepository } = createD1OrganizationInfrastructure(database, binding, activityActorContext);
    const workspace = await workspaceRepository.create({ name: "One", mission: "Goal", vision: null, principles: [], constraints: [] });
    const project = await projectRepository.createInWorkspace(workspace.id, { name: "Product", description: null, repositories: [], resources: [] });
    assert.ok(project.kind === "created");
    const access = asAccessDatabase(database);
    const projects = new D1ProjectGrantRepository(access, binding, () => 100);
    const workspaces = new D1WorkspaceGrantRepository(access, binding, () => 100);
    const grants = await Promise.all([
      projects.grant(project.project.id, "worker", "worker"),
      projects.grant(project.project.id, "worker", "worker"),
    ]);
    assert.equal(grants.filter((result) => result.kind === "granted" && result.created).length, 1);
    assert.ok(grants.every((result) => result.kind === "granted" && result.grant.createdAt === 100));
    assert.deepEqual(await projects.listProjectIds("worker"), [project.project.id]);
    assert.deepEqual(await workspaces.listWorkspaceIds("worker"), []);
    const workspaceGrants = await Promise.all([workspaces.grant(workspace.id, "strategist", "strategist"), workspaces.grant(workspace.id, "strategist", "strategist")]);
    assert.equal(workspaceGrants.filter((result) => result.kind === "granted" && result.created).length, 1);
    assert.equal(await workspaces.hasRole(workspace.id, "strategist", "strategist"), true);
    await database.insertInto("human_user").values({ id: "human", display_name: "Human", email: "test@example.test", platform_role: "owner", status: "active", created_at: 1, updated_at: 1 }).execute();
    await database.insertInto("access_credential").values({ id: "credential", scope_kind: "workspace", workspace_id: workspace.id, project_id: null,
      kind: "agent", principal_id: "bound", scopes_json: "[]", prefix: "prefix", secret_hash: "hash", expires_at: 1000,
      created_at: 1, created_by_human_user_id: "human" }).execute();
    assert.deepEqual(await projects.grant(project.project.id, "bound", "worker"), { kind: "principal_bound_elsewhere" });
    const other = await workspaceRepository.create({ name: "Other", mission: "Goal", vision: null, principles: [], constraints: [] });
    assert.deepEqual(await workspaces.grant(other.id, "bound", "strategist"), { kind: "principal_bound_elsewhere" });
    assert.deepEqual(await projects.revoke("missing", "worker", "worker"), { kind: "revoked", revoked: false });
    assert.deepEqual(await workspaces.revoke("missing", "strategist", "strategist"), { kind: "revoked", revoked: false });
    await projectRepository.archive(project.project.id, "done");
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await projects.grant(project.project.id, "other", "worker"), { kind: "project_archived" });
    assert.deepEqual(await projects.revoke(project.project.id, "worker", "worker"), { kind: "project_archived" });
    assert.deepEqual(await workspaces.grant(workspace.id, "other", "strategist"), { kind: "workspace_archived" });
    assert.deepEqual(await workspaces.revoke(workspace.id, "strategist", "strategist"), { kind: "workspace_archived" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
