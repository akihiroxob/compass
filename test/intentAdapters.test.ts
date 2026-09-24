import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/container.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;
type IntentBody = { intent: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; issues?: { path: string }[]; [key: string]: unknown } };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, app: createApp(createApplicationServices(database)) };
};

const send = (app: App, method: string, path: string, body?: string) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body });

const createProject = async (app: App, name = "Compass") => {
  const response = await send(app, "POST", "/api/projects", JSON.stringify({ name, mission: "Mission" }));
  return ((await response.json()) as { project: { id: string } }).project.id;
};

const intentInput = { title: "Improve software", desiredState: "Agents improve it", completionDefinition: "Shipped" };

const callTool = async (app: App, name: string, args: object) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};

test("Web APIでIntentを作成・一覧・詳細・更新・放棄でき、Project応答にはIntentが埋め込まれない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);

  const created = await send(app, "POST", `/api/projects/${projectId}/intents`, JSON.stringify(intentInput));
  assert.equal(created.status, 201);
  const { intent } = (await created.json()) as IntentBody;
  assert.equal(intent.status, "active");
  assert.equal(intent.projectId, projectId);

  const listed = (await (await app.request(`/api/projects/${projectId}/intents`)).json()) as { intents: unknown[] };
  assert.deepEqual(listed.intents, [intent]);
  const got = (await (await app.request(`/api/projects/${projectId}/intents/${intent.id}`)).json()) as IntentBody;
  assert.deepEqual(got.intent, intent);

  const patched = await send(app, "PATCH", `/api/projects/${projectId}/intents/${intent.id}`, JSON.stringify({ completionDefinition: "" }));
  assert.equal(patched.status, 200);
  const patchedIntent = ((await patched.json()) as IntentBody).intent;
  assert.equal(patchedIntent.completionDefinition, null);
  assert.equal(patchedIntent.title, intentInput.title);

  const abandoned = await send(app, "POST", `/api/projects/${projectId}/intents/${intent.id}/abandon`, JSON.stringify({ reason: "Changed" }));
  assert.equal(abandoned.status, 200);
  const abandonedIntent = ((await abandoned.json()) as IntentBody).intent;
  assert.equal(abandonedIntent.status, "abandoned");
  assert.equal(abandonedIntent.abandonedReason, "Changed");

  const project = ((await (await app.request(`/api/projects/${projectId}`)).json()) as { project: object }).project;
  assert.deepEqual(Object.keys(project).sort(), [
    "archiveReason", "archivedAt", "constraints", "createdAt", "description", "id", "mission", "name", "principles",
    "repositories", "resources", "status", "updatedAt", "vision",
  ]);
  await database.destroy();
});

test("放棄は本文なしでも理由なしとして受け付け、壊れたJSONは400にする", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const created = (await (await send(app, "POST", `/api/projects/${projectId}/intents`, JSON.stringify(intentInput))).json()) as IntentBody;

  const malformed = await send(app, "POST", `/api/projects/${projectId}/intents/${created.intent.id}/abandon`, "{not json");
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as ErrorBody).error.message, "Intent input is invalid");

  const abandoned = await send(app, "POST", `/api/projects/${projectId}/intents/${created.intent.id}/abandon`);
  assert.equal(abandoned.status, 200);
  const intent = ((await abandoned.json()) as IntentBody).intent;
  assert.equal(intent.status, "abandoned");
  assert.equal(intent.abandonedReason, null);
  await database.destroy();
});

test("Web APIは不正入力を400、Project/Intentなしを区別した404、Active重複と非Activeへの変更を409で返す", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const path = `/api/projects/${projectId}/intents`;

  for (const body of ["{not json", "", "null", "[]", "{}", JSON.stringify({ title: " ", desiredState: "x" })]) {
    const response = await send(app, "POST", path, body);
    assert.equal(response.status, 400, `body: ${JSON.stringify(body)}`);
    const { error } = (await response.json()) as ErrorBody;
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(error.message, "Intent input is invalid");
    assert.ok(error.issues && error.issues.length > 0);
  }
  assert.deepEqual(((await (await app.request(path)).json()) as { intents: unknown[] }).intents, []);

  const noProject = await send(app, "POST", "/api/projects/missing/intents", JSON.stringify(intentInput));
  assert.equal(noProject.status, 404);
  assert.match(((await noProject.json()) as ErrorBody).error.message, /^Project missing/);
  assert.equal((await app.request("/api/projects/missing/intents")).status, 404);

  const first = ((await (await send(app, "POST", path, JSON.stringify(intentInput))).json()) as IntentBody).intent;
  const noIntent = await app.request(`${path}/missing`);
  assert.equal(noIntent.status, 404);
  assert.match(((await noIntent.json()) as ErrorBody).error.message, /^Intent missing/);
  assert.equal((await send(app, "PATCH", `${path}/missing`, JSON.stringify({ title: "x" }))).status, 404);
  assert.equal((await send(app, "POST", `${path}/missing/abandon`)).status, 404);

  const duplicate = await send(app, "POST", path, JSON.stringify({ title: "Second", desiredState: "Second" }));
  assert.equal(duplicate.status, 409);
  const duplicateError = ((await duplicate.json()) as ErrorBody).error;
  assert.equal(duplicateError.code, "CONFLICT");
  assert.equal(duplicateError.activeIntentId, first.id);

  await send(app, "POST", `${path}/${first.id}/abandon`);
  const afterAbandon = await send(app, "PATCH", `${path}/${first.id}`, JSON.stringify({ title: "Edit" }));
  assert.equal(afterAbandon.status, 409);
  const afterAbandonError = ((await afterAbandon.json()) as ErrorBody).error;
  assert.equal(afterAbandonError.code, "CONFLICT");
  assert.equal(afterAbandonError.status, "abandoned");
  assert.equal((await send(app, "POST", `${path}/${first.id}/abandon`)).status, 409);
  assert.equal(((await (await app.request(`${path}/${first.id}`)).json()) as IntentBody).intent.title, intentInput.title);

  // 放棄後は新しいIntentを作成できる。
  assert.equal((await send(app, "POST", path, JSON.stringify(intentInput))).status, 201);
  await database.destroy();
});

test("別ProjectのURLでIntentを参照・更新・放棄すると404で、内容は露出せず変更もされない", async () => {
  const { database, app } = await setup();
  const projectA = await createProject(app, "A");
  const projectB = await createProject(app, "B");
  const { intent } = (await (await send(app, "POST", `/api/projects/${projectA}/intents`, JSON.stringify(intentInput))).json()) as IntentBody;

  const viaB = `/api/projects/${projectB}/intents/${intent.id}`;
  for (const response of [
    await app.request(viaB),
    await send(app, "PATCH", viaB, JSON.stringify({ title: "Hijacked" })),
    await send(app, "POST", `${viaB}/abandon`),
  ]) {
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), new RegExp(intentInput.title));
  }
  const still = (await (await app.request(`/api/projects/${projectA}/intents/${intent.id}`)).json()) as IntentBody;
  assert.deepEqual(still.intent, intent);
  await database.destroy();
});

test("MCPはIntent toolを公開し、Web APIと同じ保存内容・入力規則・エラーを使う", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);

  const toolsResponse = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const toolsData = (await toolsResponse.text()).split("\n").find((line) => line.startsWith("data: "))!;
  assert.deepEqual(
    (JSON.parse(toolsData.slice(6)).result.tools as { name: string }[]).map((tool) => tool.name),
    [
      "create_project", "update_project", "list_projects", "get_project",
      "create_intent", "list_intents", "get_intent", "update_intent", "abandon_intent",
      "get_role_instructions", "get_strategist_context", "get_research_request", "create_outcome", "list_outcomes", "get_outcome", "update_outcome", "cancel_outcome",
      "create_direction_decision", "decide_next_outcome",
      "create_adr_handoff_request", "record_adr_reference", "list_adr_references",
      "get_researcher_context", "list_research_requests", "register_research_result", "register_research_synthesis", "complete_research_request",
      "fetch_runtime_events", "ack_runtime_event", "record_execution_evidence", "get_outcome_execution_summary",
      // Execution（旧Wachaから移植）。同じendpointから列挙される。
      "list_stories", "list_tasks", "list_task_comments", "list_changes",
      "issue_story", "edit_story", "complete_story", "cancel_story", "issue_task", "edit_task", "cancel_task",
      "claim_task", "claim_review", "claim_acceptance", "renew_claim", "release_claim",
      "add_task_comment", "complete_task", "reviewed_task", "accept_task", "reject_task",
    ],
  );

  const created = await callTool(app, "create_intent", { projectId, ...intentInput });
  assert.equal(created.isError, undefined);
  const intentId = created.structuredContent.id as string;
  assert.equal(created.structuredContent.status, "active");

  const viaApi = (await (await app.request(`/api/projects/${projectId}/intents/${intentId}`)).json()) as IntentBody;
  assert.deepEqual(viaApi.intent, created.structuredContent);

  // WebでPATCHした内容はMCPで見え、MCPの更新はWebに反映される。
  await send(app, "PATCH", `/api/projects/${projectId}/intents/${intentId}`, JSON.stringify({ title: "Edited on Web" }));
  assert.equal((await callTool(app, "get_intent", { projectId, intentId })).structuredContent.title, "Edited on Web");
  const mcpUpdated = await callTool(app, "update_intent", { projectId, intentId, desiredState: "Edited via MCP", completionDefinition: null });
  assert.equal(mcpUpdated.isError, undefined);
  const afterMcp = ((await (await app.request(`/api/projects/${projectId}/intents/${intentId}`)).json()) as IntentBody).intent;
  assert.equal(afterMcp.desiredState, "Edited via MCP");
  assert.equal(afterMcp.completionDefinition, null);
  assert.equal(afterMcp.title, "Edited on Web");
  assert.deepEqual((await callTool(app, "list_intents", { projectId })).structuredContent.intents, [afterMcp]);

  const invalid = await callTool(app, "create_intent", { projectId, title: " ", desiredState: "x".repeat(2_001) });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "VALIDATION_ERROR");
  assert.deepEqual(
    invalid.structuredContent.error.issues.map((issue: { path: string }) => issue.path),
    ["title", "desiredState"],
  );
  assert.equal((await callTool(app, "update_intent", { projectId, intentId })).structuredContent.error.code, "VALIDATION_ERROR");

  const duplicate = await callTool(app, "create_intent", { projectId, title: "Second", desiredState: "Second" });
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.error.code, "CONFLICT");
  assert.equal(duplicate.structuredContent.error.activeIntentId, intentId);

  const otherProject = await createProject(app, "Other");
  const crossProject = await callTool(app, "get_intent", { projectId: otherProject, intentId });
  assert.equal(crossProject.isError, true);
  assert.equal(crossProject.structuredContent.error.code, "NOT_FOUND");
  assert.match(crossProject.structuredContent.error.message, /^Intent /);
  const missingProject = await callTool(app, "list_intents", { projectId: "missing" });
  assert.match(missingProject.structuredContent.error.message, /^Project missing/);

  const abandoned = await callTool(app, "abandon_intent", { projectId, intentId, reason: "Done here" });
  assert.equal(abandoned.structuredContent.status, "abandoned");
  assert.equal(abandoned.structuredContent.abandonedReason, "Done here");
  const editAfter = await callTool(app, "update_intent", { projectId, intentId, title: "x" });
  assert.equal(editAfter.structuredContent.error.code, "CONFLICT");
  assert.equal(editAfter.structuredContent.error.status, "abandoned");
  const viaApiAfter = ((await (await app.request(`/api/projects/${projectId}/intents/${intentId}`)).json()) as IntentBody).intent;
  assert.equal(viaApiAfter.status, "abandoned");
  await database.destroy();
});
