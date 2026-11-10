import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HumanActor, HumanRole } from "@compass/access";
import { createApp } from "../src/presentation/http/createApp.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * Workspace設定のWeb API。Workspace member（一覧・Role変更・除外）とWorkspace Direction RoleのGrant（一覧・付与・取消）を
 * Workspace Membershipで認可し、Memberの変更が配下Projectにも反映されること、Agent GrantがProject Grantと混ざらないことを入口から検証する。
 */

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services);
  const owner = await createTestHuman(database, { email: "owner@example.com" });
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const project = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha app" });
  const other = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const otherProject = await services.human.createWorkspaceProject.execute(actorOf(owner), other.id, { name: "Beta app" });
  return { database, services, app, owner, workspace, project, other, otherProject };
};

const call = async (app: App, human: TestHuman, path: string, init?: RequestInit) => {
  const response = await requestAs(app, human)(path, init);
  return { status: response.status, body: (await response.json()) as Json };
};

/**
 * 既存HumanをWorkspace memberにするfixture（招待による参加の検証はhumanAuth・humanAuthHttpIntegrationで行う）。
 * 配下のすべてのProjectにも同じRoleが適用される。
 */
const addMember = async (context: Awaited<ReturnType<typeof setup>>, email: string, role: HumanRole) => {
  const human = await createTestHuman(context.database, { email });
  const membershipId = await addTestWorkspaceMembership(context.database, context.workspace.id, human, role);
  return { human, membershipId };
};

test("Workspace ownerはMemberのRole変更・除外ができ、配下Projectにも次の操作から反映する。Project単位のMember・追加候補APIは無い", async () => {
  const context = await setup();
  const { app, owner, workspace, project, otherProject, database } = context;
  const base = `/api/workspaces/${workspace.id}`;
  const member = await addMember(context, "member@example.com", "administrator");

  const members = (await call(app, member.human, `${base}/members`)).body.members as Json[];
  assert.deepEqual(members.map(({ membership, human }) => [human.email, membership.role]), [["owner@example.com", "owner"], ["member@example.com", "administrator"]]);
  assert.equal(members[1].membership.workspaceId, workspace.id);
  assert.equal((await call(app, member.human, `/api/projects/${project.id}`)).body.myRole, "administrator");
  assert.equal((await call(app, member.human, `/api/projects/${otherProject.id}`)).status, 404);
  const invalid = await call(app, owner, `${base}/members/${member.membershipId}`, json("PATCH", { role: "guest" }));
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");

  // WorkspaceのRole変更は配下ProjectのRoleにもなる。
  const changed = await call(app, owner, `${base}/members/${member.membershipId}`, json("PATCH", { role: "viewer" }));
  assert.equal(changed.body.membership.role, "viewer");
  assert.equal((await call(app, member.human, `/api/projects/${project.id}`)).body.myRole, "viewer");
  assert.equal((await call(app, member.human, `/api/projects/${project.id}`, json("PATCH", { description: "x" }))).status, 403);

  // 最後のownerは降格・除外できない（409 LAST_OWNER）。
  const ownerMembership = members[0].membership.id;
  for (const init of [json("PATCH", { role: "viewer" }), { method: "DELETE" }]) {
    const lastOwner = await call(app, owner, `${base}/members/${ownerMembership}`, init);
    assert.deepEqual([lastOwner.status, lastOwner.body.error.conflict], [409, "LAST_OWNER"]);
  }

  const revoked = await call(app, owner, `${base}/members/${member.membershipId}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.notEqual(revoked.body.membership.revokedAt, null);
  // 除外したHumanはWorkspaceも配下Projectも参照できない。
  assert.equal((await call(app, member.human, base)).status, 404);
  assert.equal((await call(app, member.human, `/api/projects/${project.id}`)).status, 404);

  // Project単位のMember API・Project Memberからの追加候補・直接追加は公開しない（参加は招待で行う）。
  for (const [path, init] of [
    [`/api/projects/${project.id}/members`, undefined],
    [`${base}/member-candidates`, undefined],
    [`${base}/members`, json("POST", { humanUserId: member.human.humanUserId, role: "viewer" })],
  ] as const) {
    assert.equal((await requestAs(app, owner)(path, init)).status, 404, path);
  }
  await database.destroy();
});

test("Workspace memberの管理はownerだけで、viewerは一覧だけ、別Workspaceのownerは404", async () => {
  const context = await setup();
  const { app, workspace, other, database } = context;
  const base = `/api/workspaces/${workspace.id}`;
  const admin = await addMember(context, "admin@example.com", "administrator");
  const viewer = await addMember(context, "viewer@example.com", "viewer");

  assert.equal((await call(app, viewer.human, `${base}/members`)).status, 200);
  for (const human of [admin.human, viewer.human]) {
    const forbidden = await call(app, human, `${base}/members/${viewer.membershipId}`, json("PATCH", { role: "editor" }));
    assert.deepEqual([forbidden.status, forbidden.body.error.code, forbidden.body.error.requiredRole], [403, "FORBIDDEN", "owner"]);
    assert.equal((await call(app, human, `${base}/members/${viewer.membershipId}`, { method: "DELETE" })).status, 403);
  }

  // 別Workspaceのownerは、このWorkspaceのmember・Grant・Credentialの存在を明かされず404。
  const otherOwner = await createTestHuman(database, { email: "other-owner@example.com" });
  await addTestWorkspaceMembership(database, other.id, otherOwner, "owner");
  for (const path of ["/members", "/grants", "/credentials"]) {
    const response = await call(app, otherOwner, `${base}${path}`);
    assert.deepEqual([path, response.status, response.body.error.code], [path, 404, "NOT_FOUND"]);
  }
  // 別WorkspaceのMembershipIDは404。
  assert.equal((await call(app, context.owner, `/api/workspaces/${context.other.id}/members/${viewer.membershipId}`, json("PATCH", { role: "editor" }))).status, 404);
  await database.destroy();
});

test("Workspace Direction RoleのGrantはadministrator以上が付与・取消し、viewerは一覧だけでProject Grantと混ざらない", async () => {
  const context = await setup();
  const { app, owner, workspace, project, other, database } = context;
  const grants = `/api/workspaces/${workspace.id}/grants`;
  const admin = await addMember(context, "admin@example.com", "administrator");
  const editor = await addMember(context, "editor@example.com", "editor");
  const viewer = await addMember(context, "viewer@example.com", "viewer");

  const created = await call(app, admin.human, grants, json("POST", { principalId: "strategist-a", role: "strategist" }));
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.created, created.body.grant.workspaceId, created.body.grant.role], [true, workspace.id, "strategist"]);
  const again = await call(app, owner, grants, json("POST", { principalId: "strategist-a", role: "strategist" }));
  assert.deepEqual([again.status, again.body.created], [200, false]);
  // Execution Roleと未知のRoleはWorkspaceへ付与できない。
  for (const role of ["manager", "worker", "runtime", "owner"]) {
    const rejected = await call(app, owner, grants, json("POST", { principalId: "x", role }));
    assert.deepEqual([role, rejected.status, rejected.body.error.code], [role, 400, "VALIDATION_ERROR"]);
  }

  // editor・viewerは付与・取消できない。
  for (const human of [editor.human, viewer.human]) {
    const forbidden = await call(app, human, grants, json("POST", { principalId: "researcher-a", role: "researcher" }));
    assert.deepEqual([forbidden.status, forbidden.body.error.requiredRole], [403, "administrator"]);
    assert.equal((await call(app, human, `${grants}/strategist/strategist-a`, { method: "DELETE" })).status, 403);
  }
  const listed = await call(app, viewer.human, grants);
  assert.deepEqual(listed.body.grants.map((grant: Json) => [grant.principalId, grant.role]), [["strategist-a", "strategist"]]);
  // Workspace GrantはProject Grantの一覧に出ず、Project Grant（Execution Role）もWorkspaceの一覧に出ない。
  await call(app, owner, `/api/projects/${project.id}/grants`, json("POST", { principalId: "worker-a", role: "worker" }));
  assert.deepEqual((await call(app, owner, `/api/projects/${project.id}/grants`)).body.grants.map((grant: Json) => grant.principalId), ["worker-a"]);
  assert.deepEqual((await call(app, owner, grants)).body.grants.map((grant: Json) => grant.principalId), ["strategist-a"]);
  assert.deepEqual((await call(app, owner, `/api/workspaces/${other.id}/grants`)).body.grants, []);

  // Agent名は1つのscopeに束縛する。ProjectのGrant・別WorkspaceのGrantと共有できない。
  await call(app, owner, `/api/projects/${project.id}/credentials`, json("POST", { kind: "agent", principalId: "worker-a" }));
  const bound = await call(app, owner, grants, json("POST", { principalId: "worker-a", role: "researcher" }));
  assert.deepEqual([bound.status, bound.body.error.conflict], [409, "PRINCIPAL_BOUND_ELSEWHERE"]);

  // 取消は冪等で、principalIdはpathでURLエンコードする。
  await call(app, owner, grants, json("POST", { principalId: "team/evaluator 1", role: "evaluator" }));
  const revoked = await call(app, admin.human, `${grants}/evaluator/${encodeURIComponent("team/evaluator 1")}`, { method: "DELETE" });
  assert.deepEqual([revoked.status, revoked.body.revoked], [200, true]);
  assert.equal((await call(app, admin.human, `${grants}/evaluator/${encodeURIComponent("team/evaluator 1")}`, { method: "DELETE" })).body.revoked, false);

  // archivedのWorkspaceは一覧できるが、付与・取消は409。
  await call(app, owner, `/api/workspaces/${workspace.id}/archive`, json("POST", { reason: "done" }));
  assert.equal((await call(app, viewer.human, grants)).status, 200);
  const archived = await call(app, owner, grants, json("POST", { principalId: "researcher-a", role: "researcher" }));
  assert.deepEqual([archived.status, archived.body.error.workspaceStatus], [409, "archived"]);
  assert.equal((await call(app, owner, `${grants}/strategist/strategist-a`, { method: "DELETE" })).status, 409);
  await database.destroy();
});

test("Workspace Credentialの一覧はsecretを含まず、tokenは発行応答だけでno-store。editorには一覧も出さない", async () => {
  const context = await setup();
  const { app, owner, workspace, database } = context;
  const path = `/api/workspaces/${workspace.id}/credentials`;
  const editor = await addMember(context, "editor@example.com", "editor");
  const response = await requestAs(app, owner)(path, json("POST", { kind: "runtime", principalId: "orchestrator", scopes: ["runtime:event:read", "runtime:state:read"] }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const issued = (await response.json()) as Json;
  assert.match(issued.token, /^cmp_runtime\./);
  const listed = await call(app, owner, path);
  assert.equal(listed.body.credentials.length, 1);
  const serialized = JSON.stringify(listed.body);
  assert.doesNotMatch(serialized, new RegExp(issued.token.split(".").at(-1)));
  assert.equal("secretHash" in listed.body.credentials[0], false);
  assert.equal("token" in listed.body.credentials[0], false);
  assert.deepEqual(listed.body.credentials[0].scope, { kind: "workspace", id: workspace.id });
  assert.deepEqual([(await call(app, editor.human, path)).status, (await call(app, editor.human, path)).body.error.requiredRole], [403, "administrator"]);
  await database.destroy();
});

test("新規file DBで保存したWorkspace member・Grantは、同じschemaで再初期化した後もWeb APIから読める", async () => {
  const path = join(tmpdir(), `compass-workspace-settings-${process.pid}-${Date.now()}.sqlite`);
  try {
    const first = await setup(path);
    const member = await addMember(first, "member@example.com", "editor");
    await call(first.app, first.owner, `/api/workspaces/${first.workspace.id}/grants`, json("POST", { principalId: "researcher-a", role: "researcher" }));
    await first.database.destroy();

    const database = createDatabase(path);
    await initializeSchema(database);
    const app = createApp(createApplicationServices(database));
    const owner = await createTestHuman(database, { email: "owner@example.com" });
    const members = await call(app, owner, `/api/workspaces/${first.workspace.id}/members`);
    assert.deepEqual(members.body.members.map((item: Json) => [item.membership.id, item.membership.role]).at(-1), [member.membershipId, "editor"]);
    const grants = await call(app, owner, `/api/workspaces/${first.workspace.id}/grants`);
    assert.deepEqual(grants.body.grants.map((grant: Json) => [grant.principalId, grant.role]), [["researcher-a", "researcher"]]);
    await database.destroy();
  } finally {
    await rm(path, { force: true });
  }
});
