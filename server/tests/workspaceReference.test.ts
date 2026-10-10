import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

type Body = Record<string, any>;

const setup = async (databasePath = ":memory:") => {
  const database = createDatabase(databasePath);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services);
  return { database, services, app };
};

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });

const json = async (response: Response): Promise<Body> => (await response.json()) as Body;

const get = async (request: ReturnType<typeof requestAs>, path: string, status = 200) => {
  const response = await request(path);
  const body = await json(response);
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
};

const callTool = async (app: ReturnType<typeof createApp>, name: string, args: object, principal: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${principal}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};

/**
 * owner Aliceが2つのWorkspaceを持つ。Workspace Wには所属Project A・B、Workspace Xには所属Project Y。
 * BobはProject AのviewerでWorkspace Wのviewer（Project Bのmemberではない）。
 */
const seed = async (databasePath = ":memory:") => {
  const context = await setup(databasePath);
  const { database, services } = context;
  const alice = await createTestHuman(database, { email: "alice@example.com" });
  const bob = await createTestHuman(database, { email: "bob@example.com" });
  const projectA = await services.createProjectUseCase.execute(
    { name: "Alpha", description: "Consumer app", mission: "Make direction explicit", resources: [{ name: "Figma", url: "https://figma.example/a", kind: "design" }] },
    actorOf(alice),
  );
  const workspaceId = projectA.workspaceId;
  const projectB = await services.human.createWorkspaceProject.execute(actorOf(alice), workspaceId, {
    name: "Beta",
    description: "Platform",
    repositories: [{ name: "platform", url: "https://github.com/example/platform" }],
  });
  const projectY = await services.createProjectUseCase.execute({ name: "Other", mission: "Elsewhere" }, actorOf(alice));
  await addTestMembership(database, projectA.id, bob, "viewer");
  await services.human.addWorkspaceMember.execute(actorOf(alice), workspaceId, { humanUserId: bob.humanUserId, role: "viewer" });
  return { ...context, alice, bob, workspaceId, projectA, projectB, projectY };
};

test("Project参照は所属workspaceIdを返し、Workspaceの参照・所属Project一覧を同じIDで辿れる", async () => {
  const { database, app, alice, workspaceId, projectA, projectB, projectY } = await seed();
  const asAlice = requestAs(app, alice);

  const { project, myRole } = await get(asAlice, `/api/projects/${projectA.id}`);
  assert.equal(myRole, "owner");
  assert.equal(project.workspaceId, workspaceId);
  assert.equal(project.mission, "Make direction explicit");
  const listed = (await get(asAlice, "/api/projects")).projects as Body[];
  assert.deepEqual(
    Object.fromEntries(listed.map(({ id, workspaceId }) => [id, workspaceId])),
    { [projectA.id]: workspaceId, [projectB.id]: workspaceId, [projectY.id]: projectY.workspaceId },
  );

  const workspaces = (await get(asAlice, "/api/workspaces")).workspaces as Body[];
  assert.deepEqual(workspaces.map(({ id }) => id).sort(), [workspaceId, projectY.workspaceId].sort());
  const detail = await get(asAlice, `/api/workspaces/${workspaceId}`);
  assert.equal(detail.myRole, "owner");
  assert.equal(detail.workspace.mission, "Make direction explicit");

  const projects = (await get(asAlice, `/api/workspaces/${workspaceId}/projects`)).projects as Body[];
  assert.deepEqual(projects.map(({ id }) => id).sort(), [projectA.id, projectB.id].sort());
  const alpha = projects.find(({ id }) => id === projectA.id)!;
  assert.equal(alpha.workspaceId, workspaceId);
  assert.equal(alpha.description, "Consumer app");
  assert.deepEqual(alpha.resources.map(({ name, kind }: Body) => ({ name, kind })), [{ name: "Figma", kind: "design" }]);
  assert.equal("mission" in alpha, false, "Mission等はWorkspaceの応答を参照し、Projectごとに複製しない");
  const beta = projects.find(({ id }) => id === projectB.id)!;
  assert.deepEqual(beta.repositories.map(({ name }: Body) => name), ["platform"]);
  await database.destroy();
});

test("新規DBのWorkspace・Project・Resource参照と認可は同じschemaでの再起動後も維持される", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-reference-"));
  const databasePath = join(directory, "compass.db");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { database, services, app, alice, bob, workspaceId, projectA, projectB, projectY } = await seed(databasePath);
  let databaseClosed = false;
  t.after(async () => { if (!databaseClosed) await database.destroy(); });
  await services.grantProjectRoleUseCase.execute(projectA.id, { principalId: "planner", role: "manager" });
  await services.human.archiveProject.execute(actorOf(alice), projectB.id, { reason: "Merged" });
  await services.human.archiveProject.execute(actorOf(alice), projectY.id, { reason: "Done" });

  const paths = [
    "/api/workspaces",
    "/api/workspaces?status=archived",
    `/api/workspaces/${workspaceId}`,
    `/api/workspaces/${workspaceId}/projects`,
    `/api/workspaces/${workspaceId}/projects?status=archived`,
    `/api/workspaces/${projectY.workspaceId}`,
    `/api/workspaces/${projectY.workspaceId}/projects?status=archived`,
    `/api/projects/${projectA.id}`,
    `/api/projects/${projectB.id}`,
  ];
  const before = await Promise.all(paths.map((path) => get(requestAs(app, alice), path)));
  const agentBefore = (await callTool(app, "get_project", { projectId: projectA.id }, "planner")).structuredContent;
  await database.destroy();
  databaseClosed = true;

  const reopened = await setup(databasePath);
  t.after(() => reopened.database.destroy());
  const after = await Promise.all(paths.map((path) => get(requestAs(reopened.app, alice), path)));
  assert.deepEqual(after, before, "所属・戦略値・Resource ID・archive状態・Membershipを保存したまま再参照できる");
  assert.deepEqual(
    (await callTool(reopened.app, "get_project", { projectId: projectA.id }, "planner")).structuredContent,
    agentBefore,
    "保存済みのGrantでMCPも同じProject参照を返す",
  );
  const listed = (await callTool(reopened.app, "list_projects", {}, "planner")).structuredContent.projects as Body[];
  assert.equal(listed.find(({ id }) => id === projectA.id)!.workspaceId, workspaceId);

  const asBob = requestAs(reopened.app, bob);
  assert.equal((await get(asBob, `/api/workspaces/${workspaceId}`)).myRole, "viewer");
  assert.deepEqual(
    ((await get(asBob, `/api/workspaces/${workspaceId}/projects?status=archived`)).projects as Body[]).map(({ id }) => id),
    [projectB.id],
  );
  for (const path of [`/api/projects/${projectB.id}`, `/api/workspaces/${projectY.workspaceId}`, `/api/workspaces/${projectY.workspaceId}/projects`]) {
    assert.equal((await get(asBob, path, 404)).error.code, "NOT_FOUND");
  }
});

test("別Workspaceは未所属と存在しないIDを区別せず404で、Workspace memberにProjectの詳細を継承しない", async () => {
  const { database, app, bob, workspaceId, projectA, projectB, projectY } = await seed();
  const asBob = requestAs(app, bob);

  assert.deepEqual(((await get(asBob, "/api/workspaces")).workspaces as Body[]).map(({ id }) => id), [workspaceId]);
  assert.equal((await get(asBob, `/api/workspaces/${workspaceId}`)).myRole, "viewer");
  for (const path of [
    `/api/workspaces/${projectY.workspaceId}`,
    `/api/workspaces/${projectY.workspaceId}/projects`,
    "/api/workspaces/missing",
    "/api/workspaces/missing/projects",
  ]) {
    assert.equal((await get(asBob, path, 404)).error.code, "NOT_FOUND");
  }

  // Workspace memberは所属Projectの一覧（purpose・Resource参照）を見られるが、Project詳細はProject Membershipで認可する。
  const projects = (await get(asBob, `/api/workspaces/${workspaceId}/projects`)).projects as Body[];
  assert.deepEqual(projects.map(({ id }) => id).sort(), [projectA.id, projectB.id].sort());
  assert.equal((await get(asBob, `/api/projects/${projectA.id}`)).project.workspaceId, workspaceId);
  assert.equal((await get(asBob, `/api/projects/${projectB.id}`, 404)).error.code, "NOT_FOUND");
  assert.deepEqual(((await get(asBob, "/api/projects")).projects as Body[]).map(({ id }) => id), [projectA.id]);
  await database.destroy();
});

test("archivedのProject・Workspaceは既定の一覧から外れ、status=archivedで参照でき、不正なstatusは400", async () => {
  const { database, services, app, alice, workspaceId, projectA, projectB, projectY } = await seed();
  const asAlice = requestAs(app, alice);
  await services.human.archiveProject.execute(actorOf(alice), projectB.id, { reason: "Merged" });
  await services.human.archiveProject.execute(actorOf(alice), projectY.id, { reason: "Done" });

  assert.deepEqual(((await get(asAlice, `/api/workspaces/${workspaceId}/projects`)).projects as Body[]).map(({ id }) => id), [projectA.id]);
  const archived = (await get(asAlice, `/api/workspaces/${workspaceId}/projects?status=archived`)).projects as Body[];
  assert.deepEqual(archived.map(({ id, status, archiveReason }) => ({ id, status, archiveReason })), [
    { id: projectB.id, status: "archived", archiveReason: "Merged" },
  ]);

  // 最後のactiveなProjectのarchiveで所属Workspaceもarchivedになる。履歴として参照はできる。
  assert.deepEqual(((await get(asAlice, "/api/workspaces")).workspaces as Body[]).map(({ id }) => id), [workspaceId]);
  assert.deepEqual(
    ((await get(asAlice, "/api/workspaces?status=archived")).workspaces as Body[]).map(({ id }) => id),
    [projectY.workspaceId],
  );
  assert.equal((await get(asAlice, `/api/workspaces/${projectY.workspaceId}`)).workspace.status, "archived");
  assert.deepEqual(
    ((await get(asAlice, `/api/workspaces/${projectY.workspaceId}/projects?status=archived`)).projects as Body[]).map(({ id }) => id),
    [projectY.id],
  );

  for (const path of ["/api/workspaces?status=deleted", `/api/workspaces/${workspaceId}/projects?status=all`]) {
    const body = await get(asAlice, path, 400);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(body.error.issues.map((issue: { path: string }) => issue.path), ["status"]);
  }
  await database.destroy();
});

const send = async (request: ReturnType<typeof requestAs>, method: string, path: string, body: unknown, status: number) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await json(response);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(parsed)}`);
  return parsed;
};

test("HumanはWeb APIでWorkspaceを作成・編集し、Projectを所属させ、archiveできる。新規DBの再起動後も同じ状態を参照できる", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-manage-"));
  const databasePath = join(directory, "compass.db");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await setup(databasePath);
  const carol = await createTestHuman(first.database, { email: "carol@example.com" });
  const asCarol = requestAs(first.app, carol);

  const { workspace } = await send(asCarol, "POST", "/api/workspaces", { name: " Petari ", mission: "Small teams ship together", principles: ["Small steps"] }, 201);
  assert.deepEqual(
    { name: workspace.name, mission: workspace.mission, vision: workspace.vision, principles: workspace.principles, constraints: workspace.constraints, status: workspace.status },
    { name: "Petari", mission: "Small teams ship together", vision: null, principles: ["Small steps"], constraints: [], status: "active" },
  );
  assert.equal((await get(asCarol, `/api/workspaces/${workspace.id}`)).myRole, "owner", "作成者はWorkspaceのowner");

  const { workspace: edited } = await send(asCarol, "PATCH", `/api/workspaces/${workspace.id}`, { vision: "Every team decides with context", constraints: ["No tracking"] }, 200);
  assert.equal(edited.vision, "Every team decides with context");
  assert.deepEqual(edited.constraints, ["No tracking"]);
  assert.equal(edited.mission, "Small teams ship together", "未指定の項目は変えない");

  // Mission等はWorkspaceの正本を使い、Projectの入力では受け取らない。作成者はProjectのowner。
  const { project } = await send(asCarol, "POST", `/api/workspaces/${workspace.id}/projects`, { name: "Consumer", description: "App", mission: "ignored", resources: [{ name: "Figma", url: "https://figma.example/c", kind: "design" }] }, 201);
  assert.equal(project.workspaceId, workspace.id);
  assert.equal(project.mission, "Small teams ship together");
  assert.equal((await get(asCarol, `/api/projects/${project.id}`)).myRole, "owner");
  assert.deepEqual(((await get(asCarol, `/api/workspaces/${workspace.id}/projects`)).projects as Body[]).map(({ id }) => id), [project.id]);

  // archiveは理由が必須で、archived後は編集・Project追加・再archiveを409（workspaceStatus: archived）で拒否する。
  assert.deepEqual((await send(asCarol, "POST", `/api/workspaces/${workspace.id}/archive`, undefined, 400)).error.issues.map(({ path }: Body) => path), ["reason"]);
  const { workspace: archived } = await send(asCarol, "POST", `/api/workspaces/${workspace.id}/archive`, { reason: "Merged into Taneru" }, 200);
  assert.equal(archived.status, "archived");
  assert.equal(archived.archiveReason, "Merged into Taneru");
  for (const [method, path, body] of [
    ["PATCH", `/api/workspaces/${workspace.id}`, { name: "Renamed" }],
    ["POST", `/api/workspaces/${workspace.id}/projects`, { name: "Late" }],
    ["POST", `/api/workspaces/${workspace.id}/archive`, { reason: "Again" }],
  ] as const) {
    const error = (await send(asCarol, method, path, body, 409)).error;
    assert.equal(error.code, "CONFLICT", `${method} ${path}`);
    assert.equal(error.workspaceStatus, "archived", `${method} ${path}`);
  }
  assert.deepEqual(((await get(asCarol, "/api/workspaces?status=archived")).workspaces as Body[]).map(({ id }) => id), [workspace.id]);
  const before = await get(asCarol, `/api/workspaces/${workspace.id}`);
  await first.database.destroy();

  const reopened = await setup(databasePath);
  t.after(() => reopened.database.destroy());
  const asCarolAgain = requestAs(reopened.app, carol);
  assert.deepEqual(await get(asCarolAgain, `/api/workspaces/${workspace.id}`), before);
  assert.equal((await get(asCarolAgain, `/api/projects/${project.id}`)).project.workspaceId, workspace.id);
});

test("Workspaceの管理はWorkspace Membershipの権限表で認可し、Project Roleから継承しない。入力エラーはpath付きの400", async () => {
  const { database, services, app, alice, bob, workspaceId, projectA, projectY } = await seed();
  const asAlice = requestAs(app, alice);
  const asBob = requestAs(app, bob);
  // BobをProject Aのownerにしても、Workspaceはviewerのまま。Workspaceの管理とWorkspace戦略値の変更はできない。
  await database.updateTable("project_membership").set({ role: "owner" }).where("project_id", "=", projectA.id).where("human_user_id", "=", bob.humanUserId).execute();
  assert.equal((await get(asBob, `/api/projects/${projectA.id}`)).myRole, "owner");
  for (const [method, path, body] of [
    ["PATCH", `/api/workspaces/${workspaceId}`, { mission: "Hijacked" }],
    ["POST", `/api/workspaces/${workspaceId}/projects`, { name: "Sneaky" }],
    ["POST", `/api/workspaces/${workspaceId}/archive`, { reason: "No" }],
  ] as const) {
    const error = (await send(asBob, method, path, body, 403)).error;
    assert.equal(error.code, "FORBIDDEN", `${method} ${path}`);
  }
  // Projectの更新はMission等を受け取らない（Workspaceの正本を変えない）。
  assert.equal((await send(asBob, "PATCH", `/api/projects/${projectA.id}`, { mission: "Hijacked" }, 400)).error.code, "VALIDATION_ERROR");
  await send(asBob, "PATCH", `/api/projects/${projectA.id}`, { description: "Renamed by project owner", mission: "Hijacked" }, 200);
  assert.equal((await get(asAlice, `/api/workspaces/${workspaceId}`)).workspace.mission, "Make direction explicit");

  // administratorは編集・Project追加ができるが、archiveはownerだけ。
  await services.human.changeWorkspaceMemberRole.execute(actorOf(alice), workspaceId, (await services.human.listWorkspaceMembers.execute(actorOf(alice), workspaceId)).find(({ human }) => human.id === bob.humanUserId)!.membership.id, { role: "administrator" });
  await send(asBob, "PATCH", `/api/workspaces/${workspaceId}`, { vision: "Shared vision" }, 200);
  await send(asBob, "POST", `/api/workspaces/${workspaceId}/projects`, { name: "Gamma" }, 201);
  assert.equal((await send(asBob, "POST", `/api/workspaces/${workspaceId}/archive`, { reason: "No" }, 403)).error.code, "FORBIDDEN");

  // 別Workspace・存在しないWorkspaceは区別せず404。
  for (const path of [`/api/workspaces/${projectY.workspaceId}`, "/api/workspaces/missing"]) {
    assert.equal((await send(asBob, "PATCH", path, { name: "x" }, 404)).error.code, "NOT_FOUND");
    assert.equal((await send(asBob, "POST", `${path}/projects`, { name: "x" }, 404)).error.code, "NOT_FOUND");
  }

  const invalid = await send(asAlice, "POST", "/api/workspaces", { name: " ", principles: [""] }, 400);
  assert.deepEqual(invalid.error.issues.map(({ path }: Body) => path).sort(), ["mission", "name", "principles.0"]);
  assert.equal((await send(asAlice, "PATCH", `/api/workspaces/${workspaceId}`, {}, 400)).error.code, "VALIDATION_ERROR");
  assert.deepEqual((await send(asAlice, "POST", `/api/workspaces/${workspaceId}/projects`, { name: "", repositories: [{ name: "x", url: "file:///x" }] }, 400)).error.issues.map(({ path }: Body) => path).sort(), ["name", "repositories.0.url"]);
  const malformed = await asAlice("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  await database.destroy();
});

test("Workspaceのmember管理の入口とWorkspace管理のMCP toolは公開せず、AgentはProject参照から所属workspaceIdだけを得る", async () => {
  const { database, services, app, alice, workspaceId, projectA } = await seed();
  const asAlice = requestAs(app, alice);
  assert.equal((await asAlice(`/api/workspaces/${workspaceId}/members`)).status, 404);

  await services.grantProjectRoleUseCase.execute(projectA.id, { principalId: "planner", role: "manager" });
  const tools = ((await callTool(app, "tools/list", {}, "planner")).tools as Body[]).map(({ name }) => name);
  // Workspaceの名を持つtoolはWorkspace Activityの記録・参照とWorkspace Role Context（Workspace Role Grantで認可）、
  // Orchestrator向けの現在状態（Workspace Runtime Credentialで認可）だけで、管理操作は無い。
  assert.deepEqual(
    tools.filter((name) => name.includes("workspace")).sort(),
    ["get_workspace_activity", "get_workspace_orchestration_state", "get_workspace_role_context", "list_workspace_activities", "record_workspace_activity"],
  );
  const { structuredContent: project } = await callTool(app, "get_project", { projectId: projectA.id }, "planner");
  assert.equal(project.workspaceId, workspaceId);
  const { structuredContent: listed } = await callTool(app, "list_projects", {}, "planner");
  assert.ok((listed.projects as Body[]).every((item) => typeof item.workspaceId === "string"));
  await database.destroy();
});
