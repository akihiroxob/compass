import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
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
  const app = createApp(createApplicationServices(database));

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
  const app = createApp(createApplicationServices(database));

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
  const app = createApp(createApplicationServices(database));

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

test("MCP lists the three Project tools and reports errors", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = createApp(createApplicationServices(database));

  const toolsResponse = await mcpRequest(app, {
    jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
  });
  const tools = await readMcpData(toolsResponse);
  assert.deepEqual(
    tools.result.tools.map((tool: { name: string }) => tool.name),
    ["create_project", "list_projects", "get_project"],
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
