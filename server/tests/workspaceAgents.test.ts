import assert from "node:assert/strict";
import test from "node:test";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/presentation/http/createApp.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

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

    // 別WorkspaceのMemberはこのWorkspaceのGrantを読めない。未所属・不在は404、Session無しは401。
    const outsider = await createTestHuman(database);
    await addTestWorkspaceMembership(database, other.id, outsider, "owner");
    assert.equal((await requestAs(app, outsider)(`/api/workspaces/${workspace.id}/grants`)).status, 404);
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

const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Agent管理の操作: 複数ProjectのGrantを保持したままCredentialの束縛を拒否し、単一scopeでは発行・取消でき、editorは変更できない", async () => {
  const { database, services, app, owner, workspace, project } = await setup();
  try {
    const second = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha ops" });
    const asOwner = requestAs(app, owner);
    // 登録（PC）: 同じAgent名へProject Roleを2つのProjectに割り当てる（UIは既存のGrant APIを1件ずつ呼ぶ）。
    for (const target of [project.id, second.id]) {
      assert.equal((await asOwner(`/api/projects/${target}/grants`, postJson({ principalId: "worker-01", role: "worker" }))).status, 201);
    }
    // 複数scopeにGrantがあるAgentにはAgent Credentialを発行できず、既存Grantは削除されない。
    const bound = await asOwner(`/api/projects/${project.id}/credentials`, postJson({ kind: "agent", principalId: "worker-01", expiresInDays: 30 }));
    assert.equal(bound.status, 409);
    assert.equal(((await bound.json()) as { error: { conflict: string } }).error.conflict, "PRINCIPAL_BOUND_ELSEWHERE");
    for (const target of [project.id, second.id]) {
      const { grants } = (await (await asOwner(`/api/projects/${target}/grants`)).json()) as { grants: { principalId: string; role: string }[] };
      assert.deepEqual(grants.map(({ principalId, role }) => [principalId, role]), [["worker-01", "worker"]]);
    }

    // Workspace Roleだけを持つAgentは、Workspace scopeで発行・取消できる。
    assert.equal((await asOwner(`/api/workspaces/${workspace.id}/grants`, postJson({ principalId: "strategist-01", role: "strategist" }))).status, 201);
    const issued = await asOwner(`/api/workspaces/${workspace.id}/credentials`, postJson({ kind: "agent", principalId: "strategist-01", expiresInDays: 30 }));
    assert.equal(issued.status, 201);
    const { credential } = (await issued.json()) as { credential: { id: string } };
    assert.equal((await asOwner(`/api/workspaces/${workspace.id}/credentials/${credential.id}`, { method: "DELETE" })).status, 200);
    const { credentials } = (await (await asOwner(`/api/workspaces/${workspace.id}/credentials`)).json()) as { credentials: { revokedAt: number | null }[] };
    assert.ok(credentials[0].revokedAt !== null);

    // editorはWorkspace Roleで一覧を読めるが、Grant・Credentialを変更できない（Serverが拒否する）。
    const editor = await createTestHuman(database);
    await addTestWorkspaceMembership(database, workspace.id, editor, "editor");
    const asEditor = requestAs(app, editor);
    assert.equal((await asEditor(`/api/projects/${project.id}/grants`)).status, 200);
    assert.equal((await asEditor(`/api/projects/${project.id}/grants`, postJson({ principalId: "worker-02", role: "worker" }))).status, 403);
    assert.equal((await asEditor(`/api/workspaces/${workspace.id}/grants`, postJson({ principalId: "s2", role: "strategist" }))).status, 403);
    assert.equal((await asEditor(`/api/workspaces/${workspace.id}/credentials`, postJson({ kind: "agent", principalId: "strategist-01", expiresInDays: 30 }))).status, 403);
    assert.equal((await asEditor(`/api/projects/${project.id}/credentials`)).status, 403);
  } finally {
    await database.destroy();
  }
});
