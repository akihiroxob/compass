import assert from "node:assert/strict";
import test from "node:test";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

type Body = Record<string, any>;

const setup = async () => {
  const database = createDatabase(":memory:");
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
const seed = async () => {
  const context = await setup();
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

test("Workspaceの管理操作はWeb API・MCPへ公開せず、AgentはProject参照から所属workspaceIdだけを得る", async () => {
  const { database, services, app, alice, workspaceId, projectA } = await seed();
  const asAlice = requestAs(app, alice);
  for (const [method, path] of [
    ["POST", "/api/workspaces"],
    ["PATCH", `/api/workspaces/${workspaceId}`],
    ["POST", `/api/workspaces/${workspaceId}/archive`],
    ["POST", `/api/workspaces/${workspaceId}/projects`],
    ["GET", `/api/workspaces/${workspaceId}/members`],
  ]) {
    const response = await asAlice(path, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    assert.equal(response.status, 404, `${method} ${path}`);
  }

  await services.grantProjectRoleUseCase.execute(projectA.id, { principalId: "planner", role: "manager" });
  const tools = ((await callTool(app, "tools/list", {}, "planner")).tools as Body[]).map(({ name }) => name);
  assert.deepEqual(tools.filter((name) => name.includes("workspace")), []);
  const { structuredContent: project } = await callTool(app, "get_project", { projectId: projectA.id }, "planner");
  assert.equal(project.workspaceId, workspaceId);
  const { structuredContent: listed } = await callTool(app, "list_projects", {}, "planner");
  assert.ok((listed.projects as Body[]).every((item) => typeof item.workspaceId === "string"));
  await database.destroy();
});
