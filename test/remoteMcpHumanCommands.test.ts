import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * Task 42: Web APIで塞いだHuman向けCommandが、remote modeのMCPから実行できないことの回帰テスト
 * （docs/step-6-human-auth-design.md「MCPの認証・認可適用表（remote mode）」）。
 */

type App = ReturnType<typeof createApp>;

const humanCommandTools = ["create_project", "update_project", "create_intent", "update_intent", "abandon_intent"];

const setup = async (mode: "remote" | "trusted-local") => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services, {
    humanAuth: { mode, publicOrigin: mode === "remote" ? "https://compass.example" : "http://localhost" },
  });
  // Web UIを経由せず、application層で既存のProject・Intent・Grantを用意する。
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "Keep direction explicit" });
  const intent = await services.createIntentUseCase.execute(project.id, { title: "I", desiredState: "S" });
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "manager-1", role: "manager" });
  return { services, app, project, intent };
};

const mcp = async (app: App, method: string, params: object, authorization?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)) as { result?: Record<string, any>; error?: { message: string } };
};

const toolNames = async (app: App, authorization?: string) =>
  ((await mcp(app, "tools/list", {}, authorization)).result?.tools as { name: string }[]).map((tool) => tool.name);

/** 未知toolはJSON-RPC errorまたはisErrorの結果で拒否される。どちらでも実行されていないことを確認する。 */
const assertRejected = async (app: App, name: string, args: object, authorization?: string) => {
  const reply = await mcp(app, "tools/call", { name, arguments: args }, authorization);
  const message = reply.error?.message ?? (reply.result?.isError ? JSON.stringify(reply.result.content) : "");
  assert.match(message, new RegExp(`${name}.*not found`, "i"), `${name} must be rejected: ${JSON.stringify(reply)}`);
};

const commandArgs = (projectId: string, intentId: string): Record<string, object> => ({
  create_project: { name: "Orphan", mission: "Created via MCP" },
  update_project: { projectId, mission: "Changed via MCP" },
  create_intent: { projectId, title: "I2", desiredState: "S2" },
  update_intent: { projectId, intentId, title: "Changed via MCP" },
  abandon_intent: { projectId, intentId, reason: "via MCP" },
});

test("remote modeの匿名MCPはRole文書だけを公開し、Human向けCommandと参照toolを実行できない", async () => {
  const { services, app, project, intent } = await setup("remote");
  assert.equal((await app.request("/api/projects")).status, 401);

  assert.deepEqual(await toolNames(app), ["get_role_instructions"]);
  const instructions = await mcp(app, "tools/call", { name: "get_role_instructions", arguments: { role: "worker" } });
  assert.notEqual(instructions.result?.isError, true);

  const args = commandArgs(project.id, intent.id);
  for (const name of humanCommandTools) await assertRejected(app, name, args[name]);
  await assertRejected(app, "list_projects", {});
  await assertRejected(app, "get_project", { projectId: project.id });
  await assertRejected(app, "list_intents", { projectId: project.id });

  const projects = await services.listProjectsUseCase.execute();
  assert.deepEqual(projects.map((item) => item.name), ["Compass"]);
  const stored = await services.getIntentUseCase.execute(project.id, intent.id);
  assert.equal(stored.title, "I");
  assert.equal(stored.status, "active");
  assert.equal((await services.getProjectUseCase.execute(project.id)).mission, "Keep direction explicit");
});

test("remote modeではBearer付きでもHuman向けCommandを登録せず、Role専用toolは維持する", async () => {
  const { services, app, project, intent } = await setup("remote");
  const bearer = "Bearer manager-1";

  const names = await toolNames(app, bearer);
  for (const name of humanCommandTools) assert.ok(!names.includes(name), `${name} must not be listed`);
  assert.ok(names.includes("get_role_instructions"));
  assert.ok(names.includes("get_strategist_context"));

  const args = commandArgs(project.id, intent.id);
  for (const name of humanCommandTools) await assertRejected(app, name, args[name], bearer);

  assert.equal((await services.listProjectsUseCase.execute()).length, 1);
  assert.equal((await services.listIntentsUseCase.execute(project.id)).length, 1);
  assert.equal((await services.getIntentUseCase.execute(project.id, intent.id)).status, "active");
});

test("trusted-local modeのMCPはHuman向けCommandを従来どおり登録する", async () => {
  const { app } = await setup("trusted-local");
  const names = await toolNames(app);
  for (const name of [...humanCommandTools, "list_projects", "get_project"]) assert.ok(names.includes(name), name);
});
