import assert from "node:assert/strict";
import test from "node:test";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/container.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

const projectInput = {
  name: "Compass",
  description: "Direction management",
  mission: "Keep direction explicit",
  vision: "Sustained agent collaboration",
  principles: ["Trace decisions"],
  constraints: ["Persist state"],
  repositories: [{ name: "Compass", url: "https://github.com/example/compass" }],
  resources: [{ name: "Docs", url: "https://example.com/docs", kind: "documentation" }],
};

const mcpRequest = (app: ReturnType<typeof createApp>, body: object) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

const readMcpData = async (response: Response) => {
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

test("Web API and MCP share Project application services", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));

  const createdResponse = await app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(projectInput),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { project: { id: string } };

  const listedResponse = await mcpRequest(app, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  });
  assert.equal(listedResponse.status, 200);
  const listed = await readMcpData(listedResponse);
  assert.equal(listed.result.structuredContent.projects[0].id, created.project.id);

  const mcpCreatedResponse = await mcpRequest(app, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "create_project", arguments: { ...projectInput, name: "From MCP" } },
  });
  const mcpCreated = await readMcpData(mcpCreatedResponse);
  assert.ok(mcpCreated.result, JSON.stringify(mcpCreated));
  const mcpProjectId = mcpCreated.result.structuredContent.id;

  const apiFound = await app.request(`/api/projects/${mcpProjectId}`);
  assert.equal(apiFound.status, 200);
  assert.equal(((await apiFound.json()) as { project: { name: string } }).project.name, "From MCP");
  await database.destroy();
});

test("Web API returns stable validation and not-found errors", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));

  const invalid = await app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", mission: "" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "VALIDATION_ERROR");

  const missing = await app.request("/api/projects/missing");
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "NOT_FOUND");
  await database.destroy();
});

test("Web API rejects malformed, empty, null and array bodies with the same 400 shape", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));

  for (const body of ["{not json", "", "null", "[]"]) {
    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 400, `body: ${JSON.stringify(body)}`);
    const { error } = (await response.json()) as {
      error: { code: string; message: string; issues: unknown[] };
    };
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(error.message, "Project input is invalid");
    assert.ok(Array.isArray(error.issues) && error.issues.length > 0);
  }

  const listed = await app.request("/api/projects");
  assert.deepEqual(((await listed.json()) as { projects: unknown[] }).projects, []);
  await database.destroy();
});

test("MCP lists the Project tools and reports errors", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));

  const toolsResponse = await mcpRequest(app, {
    jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
  });
  const tools = await readMcpData(toolsResponse);
  // Intent toolはtest/intentAdapters.test.tsで確認する。ここではProject toolが変わっていないことを固定する。
  assert.deepEqual(
    tools.result.tools
      .map((tool: { name: string }) => tool.name)
      .filter((name: string) => name.endsWith("_project") || name.endsWith("_projects")),
    ["create_project", "update_project", "list_projects", "get_project"],
  );

  const missingResponse = await mcpRequest(app, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_project", arguments: { projectId: "missing" } },
  });
  const missing = await readMcpData(missingResponse);
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.error.code, "NOT_FOUND");
  await database.destroy();
});

const patchProject = (app: ReturnType<typeof createApp>, projectId: string, body: string) =>
  app.request(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });

const callTool = async (
  app: ReturnType<typeof createApp>,
  id: number,
  name: string,
  args: object,
) => {
  const response = await mcpRequest(app, {
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
  });
  return (await readMcpData(response)).result;
};

test("Web APIの更新はMCPから、MCPの更新はWeb APIから参照でき、同じ入力規則が働く", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));

  const created = (await (
    await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(projectInput),
    })
  ).json()) as { project: { id: string; repositories: { id: string }[] } };
  const projectId = created.project.id;
  const repositoryId = created.project.repositories[0]!.id;

  const patched = await patchProject(app, projectId, JSON.stringify({
    name: "Edited on Web",
    description: "",
    repositories: [{ id: repositoryId, name: "Renamed", url: "https://github.com/example/compass" }],
  }));
  assert.equal(patched.status, 200);
  const patchedBody = (await patched.json()) as { project: Record<string, unknown> };
  assert.equal(patchedBody.project.id, projectId);
  assert.equal(patchedBody.project.description, null);
  assert.equal(patchedBody.project.mission, projectInput.mission);

  const viaMcp = (await callTool(app, 1, "get_project", { projectId })).structuredContent;
  assert.equal(viaMcp.name, "Edited on Web");
  assert.equal(viaMcp.description, null);
  assert.equal(viaMcp.repositories[0].id, repositoryId);
  assert.equal(viaMcp.repositories[0].name, "Renamed");

  const mcpUpdated = await callTool(app, 2, "update_project", {
    projectId,
    mission: "Edited via MCP",
    vision: null,
    principles: [],
  });
  assert.equal(mcpUpdated.isError, undefined);
  const viaApi = (await (await app.request(`/api/projects/${projectId}`)).json()) as {
    project: { name: string; mission: string; vision: string | null; principles: string[] };
  };
  assert.equal(viaApi.project.mission, "Edited via MCP");
  assert.equal(viaApi.project.vision, null);
  assert.deepEqual(viaApi.project.principles, []);
  assert.equal(viaApi.project.name, "Edited on Web");

  const invalidViaMcp = await callTool(app, 3, "update_project", { projectId, name: " " });
  assert.equal(invalidViaMcp.isError, true);
  assert.equal(invalidViaMcp.structuredContent.error.code, "VALIDATION_ERROR");
  assert.equal(invalidViaMcp.structuredContent.error.issues[0].path, "name");
  const invalidViaApi = await patchProject(app, projectId, JSON.stringify({ name: " " }));
  assert.equal(invalidViaApi.status, 400);

  const missingViaMcp = await callTool(app, 4, "update_project", { projectId: "missing", name: "x" });
  assert.equal(missingViaMcp.isError, true);
  assert.equal(missingViaMcp.structuredContent.error.code, "NOT_FOUND");
  await database.destroy();
});

test("PATCH /api/projects/:id は不正入力を400、存在しないIDを404で返し、データを変更しない", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));
  const created = (await (
    await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(projectInput),
    })
  ).json()) as { project: { id: string } };
  const before = await (await app.request(`/api/projects/${created.project.id}`)).json();

  for (const body of ["{not json", "", "null", "[]", "{}", '{"repositories":[{"name":"x","url":"nope"}]}']) {
    const response = await patchProject(app, created.project.id, body);
    assert.equal(response.status, 400, `body: ${JSON.stringify(body)}`);
    const { error } = (await response.json()) as { error: { code: string; issues: unknown[] } };
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.ok(error.issues.length > 0);
  }
  const urlIssue = (await (
    await patchProject(app, created.project.id, '{"repositories":[{"name":"x","url":"nope"}]}')
  ).json()) as { error: { issues: { path: string }[] } };
  assert.equal(urlIssue.error.issues[0]?.path, "repositories.0.url");

  const missing = await patchProject(app, "missing", JSON.stringify({ name: "x" }));
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "NOT_FOUND");

  assert.deepEqual(await (await app.request(`/api/projects/${created.project.id}`)).json(), before);
  await database.destroy();
});
