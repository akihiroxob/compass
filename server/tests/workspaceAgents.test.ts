import assert from "node:assert/strict";
import test from "node:test";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * S11-02: WorkspaceのAgent画面が読むWeb API。Workspace Direction RoleのGrantはWorkspace Membershipで読み、Project Grantを含めない。
 * Role DefinitionとSkillのmetadataは認証済みHumanが読め、Runtime・未知のRoleは404。
 */

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services);
  const owner = await createTestHuman(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const other = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const project = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha app" });
  return { database, services, app, owner, workspace, other, project };
};

test("Workspace GrantはWorkspace Membership（viewer以上）で読め、Project Grant・他WorkspaceのGrantを含めない", async () => {
  const { database, services, app, owner, workspace, other, project } = await setup();
  try {
    await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "strategist-01", role: "strategist" });
    await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "nagi", role: "researcher" });
    await services.grantWorkspaceRoleUseCase.execute(other.id, { principalId: "evaluator-x", role: "evaluator" });
    await services.grantProjectRoleUseCase.execute(project.id, { principalId: "atlas", role: "manager" });

    const viewer = await createTestHuman(database);
    await addTestWorkspaceMembership(database, workspace.id, viewer, "viewer");
    for (const human of [owner, viewer]) {
      const response = await requestAs(app, human)(`/api/workspaces/${workspace.id}/grants`);
      assert.equal(response.status, 200);
      const { grants } = (await response.json()) as { grants: { workspaceId: string; principalId: string; role: string }[] };
      assert.deepEqual(grants.map(({ role, principalId }) => [role, principalId]), [["researcher", "nagi"], ["strategist", "strategist-01"]]);
      assert.ok(grants.every((grant) => grant.workspaceId === workspace.id));
    }

    // Project MembershipだけのHumanはWorkspaceのGrantを読めない（継承しない）。未所属・不在は404、Session無しは401。
    const projectOnly = await createTestHuman(database);
    await addTestMembership(database, project.id, projectOnly, "owner");
    assert.equal((await requestAs(app, projectOnly)(`/api/workspaces/${workspace.id}/grants`)).status, 404);
    assert.equal((await requestAs(app, owner)("/api/workspaces/missing/grants")).status, 404);
    assert.equal((await app.request(`/api/workspaces/${workspace.id}/grants`)).status, 401);
  } finally {
    await database.destroy();
  }
});

test("Role DefinitionとSkillのmetadataは認証済みHumanが読め、Runtime・未知のRoleは404", async () => {
  const { database, app, owner } = await setup();
  try {
    const worker = await requestAs(app, owner)("/api/agent-roles/worker");
    assert.equal(worker.status, 200);
    const body = (await worker.json()) as { role: { name: string; path: string; content: string }; skills: { name: string; requiredTools: string[] }[]; source: { revision: string | null } };
    assert.equal(body.role.name, "worker");
    assert.equal(body.role.path, "roles/worker.md");
    assert.match(body.role.content, /# Worker Role/);
    assert.ok(body.skills.some((skill) => skill.name === "implement-task"));
    assert.ok("revision" in body.source);
    assert.equal("policies" in body, false);

    const strategist = await requestAs(app, owner)("/api/agent-roles/strategist");
    assert.equal(strategist.status, 200);
    assert.equal(((await strategist.json()) as { role: { path: string } }).role.path, "roles/strategist.md");

    for (const role of ["runtime", "unknown", "..%2Froles%2Fworker"]) {
      assert.equal((await requestAs(app, owner)(`/api/agent-roles/${role}`)).status, 404, role);
    }
    assert.equal((await app.request("/api/agent-roles/worker")).status, 401);
  } finally {
    await database.destroy();
  }
});
