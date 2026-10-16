import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HumanActor, HumanRole } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * Workspace設定（S11-03）のWeb API。Workspace member（一覧・追加候補・追加・Role変更・取消）とWorkspace Direction RoleのGrant
 * （一覧・付与・取消）をWorkspace Membershipで認可し、Project Membership・Project Grantと互いに継承しないことを入口から検証する。
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

/** ProjectのMemberにしてから、Workspace ownerがWeb APIでWorkspace memberに追加する。 */
const addMember = async (context: Awaited<ReturnType<typeof setup>>, email: string, role: HumanRole, projectRole: HumanRole = "viewer") => {
  const human = await createTestHuman(context.database, { email });
  await addTestMembership(context.database, context.project.id, human, projectRole);
  const added = await call(context.app, context.owner, `/api/workspaces/${context.workspace.id}/members`, json("POST", { humanUserId: human.humanUserId, role }));
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return { human, membershipId: added.body.membership.id as string };
};

test("Workspace ownerは追加候補から所属ProjectのMemberを追加・Role変更・取消でき、Project Membershipは変わらない", async () => {
  const context = await setup();
  const { app, owner, workspace, project, otherProject, database } = context;
  const base = `/api/workspaces/${workspace.id}`;
  const candidate = await createTestHuman(database, { email: "candidate@example.com" });
  await addTestMembership(database, project.id, candidate, "editor");
  // 別WorkspaceのProject Memberは候補に出ず、追加もHumanの有無を区別せず404。
  const outsider = await createTestHuman(database, { email: "outsider@example.com" });
  await addTestMembership(database, otherProject.id, outsider, "owner");

  const candidates = await call(app, owner, `${base}/member-candidates`);
  assert.equal(candidates.status, 200);
  assert.deepEqual(candidates.body.candidates.map((item: Json) => item.email), ["candidate@example.com"]);
  assert.deepEqual(Object.keys(candidates.body.candidates[0]).sort(), ["displayName", "email", "id"]);
  assert.equal((await call(app, owner, `${base}/members`, json("POST", { humanUserId: outsider.humanUserId, role: "viewer" }))).status, 404);
  const invalid = await call(app, owner, `${base}/members`, json("POST", { humanUserId: candidate.humanUserId, role: "guest" }));
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");

  const added = await call(app, owner, `${base}/members`, json("POST", { humanUserId: candidate.humanUserId, role: "administrator" }));
  assert.equal(added.status, 201);
  assert.equal(added.body.membership.workspaceId, workspace.id);
  // 追加済みは候補から外れ、二重追加は409 ALREADY_MEMBER。
  assert.deepEqual((await call(app, owner, `${base}/member-candidates`)).body.candidates, []);
  const duplicate = await call(app, owner, `${base}/members`, json("POST", { humanUserId: candidate.humanUserId, role: "viewer" }));
  assert.deepEqual([duplicate.status, duplicate.body.error.conflict], [409, "ALREADY_MEMBER"]);

  const members = (await call(app, candidate, `${base}/members`)).body.members as Json[];
  assert.deepEqual(members.map(({ membership, human }) => [human.email, membership.role]), [["owner@example.com", "owner"], ["candidate@example.com", "administrator"]]);
  const changed = await call(app, owner, `${base}/members/${added.body.membership.id}`, json("PATCH", { role: "viewer" }));
  assert.equal(changed.body.membership.role, "viewer");
  // WorkspaceのRole変更はProjectのRoleを変えない。
  assert.equal((await call(app, candidate, `/api/projects/${project.id}`)).body.myRole, "editor");

  // 最後のownerは降格・取消できない（409 LAST_OWNER）。
  const ownerMembership = members[0].membership.id;
  for (const init of [json("PATCH", { role: "viewer" }), { method: "DELETE" }]) {
    const lastOwner = await call(app, owner, `${base}/members/${ownerMembership}`, init);
    assert.deepEqual([lastOwner.status, lastOwner.body.error.conflict], [409, "LAST_OWNER"]);
  }

  const revoked = await call(app, owner, `${base}/members/${added.body.membership.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.notEqual(revoked.body.membership.revokedAt, null);
  // 取消したHumanはWorkspaceを参照できず、候補へ戻る。Projectには引き続き入れる。
  assert.equal((await call(app, candidate, base)).status, 404);
  assert.deepEqual((await call(app, owner, `${base}/member-candidates`)).body.candidates.map((item: Json) => item.email), ["candidate@example.com"]);
  assert.equal((await call(app, candidate, `/api/projects/${project.id}`)).status, 200);
  await database.destroy();
});

test("Workspace memberの管理はownerだけで、viewerは一覧だけ、Project ownerはWorkspaceのMemberでなければ404", async () => {
  const context = await setup();
  const { app, workspace, project, database } = context;
  const base = `/api/workspaces/${workspace.id}`;
  const admin = await addMember(context, "admin@example.com", "administrator");
  const viewer = await addMember(context, "viewer@example.com", "viewer");

  assert.equal((await call(app, viewer.human, `${base}/members`)).status, 200);
  for (const human of [admin.human, viewer.human]) {
    assert.equal((await call(app, human, `${base}/member-candidates`)).status, 403);
    const forbidden = await call(app, human, `${base}/members/${viewer.membershipId}`, json("PATCH", { role: "editor" }));
    assert.deepEqual([forbidden.status, forbidden.body.error.code, forbidden.body.error.requiredRole], [403, "FORBIDDEN", "owner"]);
    assert.equal((await call(app, human, `${base}/members/${viewer.membershipId}`, { method: "DELETE" })).status, 403);
  }

  // ProjectのownerでもWorkspace Membershipが無ければ、Workspaceのmember・Grant・Credentialは存在を明かさず404。
  const projectOwner = await createTestHuman(database, { email: "project-owner@example.com" });
  await addTestMembership(database, project.id, projectOwner, "owner");
  for (const path of ["/members", "/member-candidates", "/grants", "/credentials"]) {
    const response = await call(app, projectOwner, `${base}${path}`);
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
  const editor = await addMember(context, "editor@example.com", "editor", "owner");
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

  // editor（Projectではowner）・viewerは付与・取消できない。Project RoleからWorkspaceの管理権限を継承しない。
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
