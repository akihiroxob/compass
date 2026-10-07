import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import { SQLiteWorkspaceGrantRepository, workspaceRoles, executionRoles } from "@compass/access";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { asAccessDatabase, asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { accessWorkspaceReaders } from "../src/infrastructure/repository/contextAdapters.ts";

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  return { database, services: createApplicationServices(database) };
};
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, expected);
  return true;
};

test("Workspace Grantは再発行・取消が冪等でscope/role/principalを混同しない", async () => {
  const { database, services: s } = await setup();
  try {
    const a = await s.human.createWorkspace.execute({ name: "A", mission: "A" });
    const b = await s.human.createWorkspace.execute({ name: "B", mission: "B" });
    const input = { principalId: " agent ", role: "strategist" };
    const first = await s.grantWorkspaceRoleUseCase.execute(a.id, input);
    assert.equal(first.created, true);
    assert.equal(first.grant.principalId, "agent");
    assert.deepEqual(await s.grantWorkspaceRoleUseCase.execute(a.id, input), { grant: first.grant, created: false });
    await s.grantWorkspaceRoleUseCase.execute(a.id, { principalId: "agent", role: "researcher" });
    await s.grantWorkspaceRoleUseCase.execute(b.id, input);
    await s.grantWorkspaceRoleUseCase.execute(a.id, { principalId: "Agent", role: "strategist" });
    assert.deepEqual((await s.listWorkspaceGrantsUseCase.execute(a.id)).map(g => [g.role, g.principalId]),
      [["researcher", "agent"], ["strategist", "Agent"], ["strategist", "agent"]]);
    assert.equal(await s.revokeWorkspaceRoleUseCase.execute(a.id, input), true);
    assert.equal(await s.revokeWorkspaceRoleUseCase.execute(a.id, input), false);
    assert.equal((await s.listWorkspaceGrantsUseCase.execute(b.id)).length, 1);
    await assert.rejects(s.roleScopeAuthorizationService.requireRole("agent", { kind: "workspace", id: a.id }, "strategist"), code("FORBIDDEN"));
    assert.equal(await s.roleScopeAuthorizationService.requireRole("agent", { kind: "workspace", id: a.id }, "researcher"), "agent");
  } finally { await database.destroy(); }
});

test("Workspace入力・FK・archiveガードを検証し、archive後も読取を保つ", async () => {
  const { database, services: s } = await setup();
  try {
    const a = await s.human.createWorkspace.execute({ name: "A", mission: "A" });
    const valid = { principalId: "agent", role: "strategist" };
    for (const role of [...executionRoles, "runtime", "Strategist", null]) {
      await assert.rejects(s.grantWorkspaceRoleUseCase.execute(a.id, { ...valid, role }), code("VALIDATION_ERROR"));
      await assert.rejects(s.revokeWorkspaceRoleUseCase.execute(a.id, { ...valid, role }), code("VALIDATION_ERROR"));
    }
    for (const principalId of ["", " ", "a\nb", "x".repeat(101)]) {
      await assert.rejects(s.grantWorkspaceRoleUseCase.execute("missing", { ...valid, principalId }), code("VALIDATION_ERROR"));
    }
    await assert.rejects(s.grantWorkspaceRoleUseCase.execute("missing", valid), code("NOT_FOUND"));
    await assert.rejects(s.revokeWorkspaceRoleUseCase.execute("missing", valid), code("NOT_FOUND"));
    await assert.rejects(s.listWorkspaceGrantsUseCase.execute("missing"), code("NOT_FOUND"));
    await assert.rejects(database.insertInto("workspace_grant").values({ workspace_id: "missing", principal_id: "agent", role: "strategist", created_at: 1 }).execute(), /FOREIGN KEY/);
    await assert.rejects(database.insertInto("workspace_grant").values({ workspace_id: a.id, principal_id: "agent", role: "worker", created_at: 1 }).execute(), /CHECK/);
    const first = await s.grantWorkspaceRoleUseCase.execute(a.id, valid);
    await new ArchiveWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute(a.id, { reason: "done" });
    await assert.rejects(s.grantWorkspaceRoleUseCase.execute(a.id, valid), code("CONFLICT"));
    await assert.rejects(s.revokeWorkspaceRoleUseCase.execute(a.id, valid), code("CONFLICT"));
    assert.deepEqual(await s.listWorkspaceGrantsUseCase.execute(a.id), [first.grant]);
  } finally { await database.destroy(); }
});

test("明示scope認可は全Roleのscope・activeRole一致を要求し、Grantを継承・合算しない", async () => {
  const { database, services: s } = await setup();
  try {
    const p = await s.createProjectUseCase.execute({ name: "P", mission: "P" });
    const q = await s.createProjectUseCase.execute({ name: "Q", mission: "Q" });
    const ws = { kind: "workspace", id: p.workspaceId } as const;
    const ps = { kind: "project", id: p.id } as const;
    for (const role of workspaceRoles) {
      await s.grantWorkspaceRoleUseCase.execute(ws.id, { principalId: "multi", role });
      // 切替前のProject Grantに同じRoleが存在しても明示Project scopeでは拒否する。
      await s.grantProjectRoleUseCase.execute(ps.id, { principalId: "multi", role });
      assert.equal(await s.roleScopeAuthorizationService.requireRole("multi", ws, role), "multi");
      await assert.rejects(s.roleScopeAuthorizationService.requireRole("multi", ps, role), code("FORBIDDEN"));
      await assert.rejects(s.roleScopeAuthorizationService.requireRole("multi", { kind: "workspace", id: q.workspaceId }, role), code("FORBIDDEN"));
      await assert.rejects(s.roleScopeAuthorizationService.requireRole("multi", { kind: "workspace", id: p.id }, role), code("FORBIDDEN"));
    }
    for (const role of executionRoles) {
      await s.grantProjectRoleUseCase.execute(ps.id, { principalId: "multi", role });
      assert.equal(await s.roleScopeAuthorizationService.requireRole("multi", ps, role), "multi");
      await assert.rejects(s.roleScopeAuthorizationService.requireRole("multi", ws, role), code("FORBIDDEN"));
      await assert.rejects(s.roleScopeAuthorizationService.requireRole("multi", { kind: "project", id: q.id }, role), code("FORBIDDEN"));
    }
    for (const activeRole of [...workspaceRoles, ...executionRoles]) {
      const auth = s.forActiveRole(activeRole).roleScopeAuthorizationService;
      for (const role of [...workspaceRoles, ...executionRoles]) {
        const scope = workspaceRoles.some(r => r === role) ? ws : ps;
        if (role === activeRole) assert.equal(await auth.requireRole("multi", scope, role), "multi");
        else await assert.rejects(auth.requireRole("multi", scope, role), code("FORBIDDEN"));
      }
    }
    await s.grantWorkspaceRoleUseCase.execute(ws.id, { principalId: "workspace-only", role: "strategist" });
    await s.grantProjectRoleUseCase.execute(ps.id, { principalId: "project-only", role: "manager" });
    await assert.rejects(s.roleScopeAuthorizationService.requireRole("workspace-only", ps, "manager"), code("FORBIDDEN"));
    await assert.rejects(s.roleScopeAuthorizationService.requireRole("project-only", ws, "strategist"), code("FORBIDDEN"));
    await assert.rejects(s.forActiveRole("strategist").roleScopeAuthorizationService.requireRole("project-only", ps, "manager"), code("FORBIDDEN"));
    await assert.rejects(s.roleScopeAuthorizationService.requireRole(null, ws, "strategist"), code("UNAUTHENTICATED"));
    await assert.rejects(s.roleScopeAuthorizationService.requireRole("multi", ws, "runtime"), code("FORBIDDEN"));
    let called = false;
    await assert.rejects(s.roleScopeAuthorizationService.asRole("workspace-only", ps, "worker", async () => { called = true; }), code("FORBIDDEN"));
    assert.equal(called, false);
    // 現行Work入口でもWorkspace GrantだけでTask操作権を得ない。
    await assert.rejects(s.taskCoordinationService.listTasks("workspace-only", p.id), code("FORBIDDEN"));
  } finally { await database.destroy(); }
});

test("新規file DBのWorkspace Grantは同じschemaの再初期化後も保持される", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-workspace-grant-"));
  const path = join(dir, "test.db");
  try {
    const first = await setup(path);
    const ws = await first.services.human.createWorkspace.execute({ name: "W", mission: "W" });
    const grants = [];
    for (const role of workspaceRoles) grants.push((await first.services.grantWorkspaceRoleUseCase.execute(ws.id, { principalId: "agent", role })).grant);
    await first.database.destroy();
    const second = await setup(path);
    try {
      assert.deepEqual(await second.services.listWorkspaceGrantsUseCase.execute(ws.id), grants.sort((a, b) => a.role.localeCompare(b.role)));
      const repo = new SQLiteWorkspaceGrantRepository(asAccessDatabase(second.database), accessWorkspaceReaders);
      assert.deepEqual(await repo.listWorkspaceIds("agent"), [ws.id]);
      assert.deepEqual(await repo.listWorkspaceIds("agent", "researcher"), [ws.id]);
      assert.deepEqual(await repo.listWorkspaceIds("other"), []);
      assert.equal(await second.services.forActiveRole("evaluator").roleScopeAuthorizationService.requireRole("agent", { kind: "workspace", id: ws.id }, "evaluator"), "agent");
    } finally { await second.database.destroy(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
