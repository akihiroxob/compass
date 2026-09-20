import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { resolvePrincipal } from "../src/presentation/mcp/resolvePrincipal.ts";

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: createApp(services) };
};

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const mcp = (app: App, body: object, authorization?: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify(body),
  });

const readData = async (response: Response) => {
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const callTool = async (app: App, name: string, args: object, principal?: string): Promise<ToolResult> => {
  const response = await mcp(
    app,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    principal === undefined ? undefined : `Bearer ${principal}`,
  );
  assert.equal(response.status, 200);
  return (await readData(response)).result;
};

const createProject = async (app: App, name = "Compass") =>
  (
    (await (
      await send(app, "POST", "/api/projects", {
        name,
        mission: "Keep direction explicit",
        principles: ["Agents decide, humans observe"],
        constraints: ["No autonomous execution yet"],
      })
    ).json()) as { project: { id: string } }
  ).project.id;

const createIntent = async (app: App, projectId: string) =>
  ((await (await send(app, "POST", `/api/projects/${projectId}/intents`, { title: "I", desiredState: "S" })).json()) as {
    intent: { id: string };
  }).intent.id;

const grant = (app: App, projectId: string, principalId: string) =>
  send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role: "strategist" });

const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [
    { description: "duplicate_claim_count = 0", measurement: "Count duplicates", target: "= 0" },
    { description: "Audited", measurement: "Change log entry exists" },
  ],
};

const outcomesOf = async (app: App, projectId: string, intentId: string) =>
  ((await (await app.request(`/api/projects/${projectId}/intents/${intentId}/outcomes`)).json()) as { outcomes: unknown[] })
    .outcomes;

test("StrategistはBearerだけでContextを取得し、create_outcomeで登録でき、Webから同じ内容が見える", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const intentId = await createIntent(app, projectId);
  await grant(app, projectId, "strat-1");

  const context = await callTool(app, "get_strategist_context", { projectId }, "strat-1");
  assert.equal(context.isError, undefined);
  const value = context.structuredContent;
  assert.equal(value.principalId, "strat-1");
  assert.equal(value.role, "strategist");
  assert.equal(value.project.id, projectId);
  assert.deepEqual(value.project.principles, ["Agents decide, humans observe"]);
  assert.deepEqual(value.project.constraints, ["No autonomous execution yet"]);
  assert.equal(value.activeIntent.id, intentId);
  assert.deepEqual(value.outcomes, []);
  assert.deepEqual(value.unavailable, ["research", "evaluation", "evidence"]);

  const created = await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "strat-1");
  assert.equal(created.isError, undefined);
  const outcome = created.structuredContent.outcome;
  assert.equal(outcome.status, "active");
  const viaWeb = (await (await app.request(`/api/projects/${projectId}/intents/${intentId}/outcomes/${outcome.id}`)).json()) as {
    outcome: { rationale: string; successCriteria: unknown[] };
  };
  assert.deepEqual(viaWeb.outcome, outcome);
  assert.equal(viaWeb.outcome.rationale, outcomeInput.rationale);
  assert.equal(viaWeb.outcome.successCriteria.length, 2);

  // 取消したOutcomeも、次のContextに理由付きで残る。
  await callTool(app, "cancel_outcome", { projectId, intentId, outcomeId: outcome.id, reason: "Wrong metric" }, "strat-1");
  const after = await callTool(app, "get_strategist_context", { projectId }, "strat-1");
  assert.deepEqual(
    after.structuredContent.outcomes.map((item: { id: string; status: string; cancelReason: string }) => [item.id, item.status, item.cancelReason]),
    [[outcome.id, "cancelled", "Wrong metric"]],
  );
  await database.destroy();
});

test("Active Intentが無いProjectのContextはactiveIntent:null・outcomes:[]で、エラーにならない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "strat-1");
  const context = await callTool(app, "get_strategist_context", { projectId }, "strat-1");
  assert.equal(context.isError, undefined);
  assert.equal(context.structuredContent.activeIntent, null);
  assert.deepEqual(context.structuredContent.outcomes, []);
  await database.destroy();
});

test("Bearerなしは、Strategist要求のtoolをUNAUTHENTICATEDで拒否し、Outcomeを作らない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const intentId = await createIntent(app, projectId);
  await grant(app, projectId, "strat-1");
  const outcomeId = ((await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "strat-1")).structuredContent.outcome as { id: string }).id;

  const calls: [string, object][] = [
    ["get_strategist_context", { projectId }],
    ["create_outcome", { projectId, intentId, ...outcomeInput }],
    ["update_outcome", { projectId, intentId, outcomeId, title: "X" }],
    ["cancel_outcome", { projectId, intentId, outcomeId, reason: "r" }],
  ];
  for (const [name, args] of calls) {
    const result = await callTool(app, name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, "UNAUTHENTICATED", name);
  }
  assert.equal((await outcomesOf(app, projectId, intentId)).length, 1);
  await database.destroy();
});

test("Grantなし・別Projectだけ・存在しないProjectはすべて同じFORBIDDENで、Projectの存在を漏らさない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app, "P");
  const otherId = await createProject(app, "Q");
  const intentId = await createIntent(app, projectId);
  await grant(app, otherId, "strat-1");

  const results = [
    await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "strat-1"),
    await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "nobody"),
    await callTool(app, "get_strategist_context", { projectId: "missing-project" }, "strat-1"),
    await callTool(app, "create_outcome", { projectId: "missing-project", intentId, ...outcomeInput }, "strat-1"),
  ];
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "FORBIDDEN");
    assert.equal(result.structuredContent.error.requiredRole, "strategist");
    assert.doesNotMatch(result.structuredContent.error.message, /not found|was not found/i);
  }
  assert.equal((await outcomesOf(app, projectId, intentId)).length, 0);
  await database.destroy();
});

test("Grantの取消は再起動なしで次の呼び出しから反映され、作成済みOutcomeは残る", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const intentId = await createIntent(app, projectId);
  await grant(app, projectId, "strat-1");
  assert.equal((await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "strat-1")).isError, undefined);

  await send(app, "DELETE", `/api/projects/${projectId}/grants/strategist/strat-1`);
  const denied = await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "strat-1");
  assert.equal(denied.structuredContent.error.code, "FORBIDDEN");
  assert.equal((await callTool(app, "get_strategist_context", { projectId }, "strat-1")).structuredContent.error.code, "FORBIDDEN");
  assert.equal((await outcomesOf(app, projectId, intentId)).length, 1);

  await grant(app, projectId, "strat-1");
  assert.equal((await callTool(app, "create_outcome", { projectId, intentId, ...outcomeInput }, "strat-1")).isError, undefined);
  await database.destroy();
});

test("不正なAuthorizationは401でtoolへ進まず、anonymousへ降格しない", async () => {
  const { database, app } = await setup();
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  for (const header of ["Basic abc", "Bearer ", "Bearer", "", `Bearer ${"a".repeat(101)}`, "Bearer a\u0007b"]) {
    const response = await mcp(app, body, header);
    assert.equal(response.status, 401, JSON.stringify(header));
    const value = (await response.json()) as { error: { code: number; message: string } };
    assert.equal(value.error.code, -32001);
    assert.equal(value.error.message, "Authorization: Bearer <AgentName> is malformed");
  }
  await database.destroy();
});

test("request本文・tool入力のrole/principalId・session IDは認証情報として扱わない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const intentId = await createIntent(app, projectId);
  await grant(app, projectId, "strat-1");

  // tool入力へ他人のprincipalId・roleを入れても、Bearerのnobodyが評価される。
  const spoofed = await callTool(
    app,
    "create_outcome",
    { projectId, intentId, ...outcomeInput, role: "strategist", principalId: "strat-1" },
    "nobody",
  );
  assert.equal(spoofed.structuredContent.error.code, "FORBIDDEN");

  // Bearerなしでprincipalをtool入力・session IDに載せても認証されない。
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": "strat-1",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_strategist_context", arguments: { projectId, principalId: "strat-1", role: "strategist" } },
    }),
  });
  const data = await readData(response);
  assert.equal(data.result.structuredContent.error.code, "UNAUTHENTICATED");
  assert.equal((await outcomesOf(app, projectId, intentId)).length, 0);
  await database.destroy();
});

test("StrategistのGrantを持つPrincipalはProject・Intentの管理toolを拒否され、Bearerなしは従来どおり成功する", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const intentId = await createIntent(app, projectId);
  await grant(app, projectId, "strat-1");
  const otherId = await createProject(app, "Q");

  const guarded: [string, object][] = [
    ["update_project", { projectId, name: "Renamed" }],
    ["create_intent", { projectId, title: "T", desiredState: "D" }],
    ["update_intent", { projectId, intentId, title: "Renamed" }],
    ["abandon_intent", { projectId, intentId }],
  ];
  for (const [name, args] of guarded) {
    const denied = await callTool(app, name, args, "strat-1");
    assert.equal(denied.isError, true, name);
    assert.equal(denied.structuredContent.error.code, "FORBIDDEN", name);
  }
  const intent = ((await (await app.request(`/api/projects/${projectId}/intents/${intentId}`)).json()) as { intent: { status: string; title: string } }).intent;
  assert.deepEqual([intent.status, intent.title], ["active", "I"]);

  // 別ProjectのStrategistは、Grantを持たないProjectのIntentを従来どおり操作できる（Grantの範囲はProject scope）。
  assert.equal((await callTool(app, "update_project", { projectId: otherId, name: "Q2" }, "strat-1")).isError, undefined);
  // Bearerなし・Grantなしの呼び出しは従来どおり。
  assert.equal((await callTool(app, "update_intent", { projectId, intentId, title: "By operator" })).isError, undefined);
  assert.equal((await callTool(app, "update_intent", { projectId, intentId, title: "By other" }, "someone")).isError, undefined);
  assert.equal((await callTool(app, "abandon_intent", { projectId, intentId })).isError, undefined);
  await database.destroy();
});

test("initialize・tools/listはBearerなしで成功し、Grant管理toolを公開しない", async () => {
  const { database, app } = await setup();
  const init = await mcp(app, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(init.status, 200);
  assert.equal((await readData(init)).result.serverInfo.name, "compass");

  const listed = await readData(await mcp(app, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  const names = (listed.result.tools as { name: string }[]).map((tool) => tool.name);
  assert.ok(names.includes("get_strategist_context"));
  assert.equal(names.filter((name) => /grant|role/i.test(name)).length, 0);

  // Bearer付きでも同じ。
  const withBearer = await readData(await mcp(app, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, "Bearer strat-1"));
  assert.deepEqual((withBearer.result.tools as { name: string }[]).map((tool) => tool.name), names);
  await database.destroy();
});

test("Web APIのOutcome操作はPrincipalなしで従来どおり動く", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const intentId = await createIntent(app, projectId);
  const created = await send(app, "POST", `/api/projects/${projectId}/intents/${intentId}/outcomes`, outcomeInput);
  assert.equal(created.status, 201);
  await database.destroy();
});

test("resolvePrincipalはBearerの値をtrimしてPrincipalにし、ヘッダー無しはnull", () => {
  assert.equal(resolvePrincipal(null), null);
  assert.equal(resolvePrincipal("Bearer strat-1"), "strat-1");
  assert.equal(resolvePrincipal("bearer   Strat-1  "), "Strat-1");
  assert.equal(resolvePrincipal(`Bearer ${"a".repeat(100)}`), "a".repeat(100));
});
