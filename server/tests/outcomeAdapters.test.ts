import assert from "node:assert/strict";
import test from "node:test";
import type { createApp } from "../src/presentation/http/createApp.ts";
import { createSignedInApp, seedProjectWorkspaceGrant } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/bootstrap/container.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;
type OutcomeBody = { outcome: { id: string; status: string; successCriteria: { position: number; description: string }[]; [key: string]: unknown } };
type ErrorBody = { error: { code: string; message: string; issues?: { path: string }[]; [key: string]: unknown } };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, app: await createSignedInApp(database, createApplicationServices(database)) };
};

const send = (app: App, method: string, path: string, body?: string) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body });

const createProjectAndIntent = async (app: App) => {
  const project = (await (await send(app, "POST", "/api/projects", JSON.stringify({ name: "Compass", mission: "M" }))).json()) as { project: { id: string; workspaceId: string } };
  const intent = (await (await send(app, "POST", `/api/workspaces/${project.project.workspaceId}/intents`, JSON.stringify({ title: "I", desiredState: "S" }))).json()) as { intent: { id: string } };
  return { projectId: project.project.id, workspaceId: project.project.workspaceId, intentId: intent.intent.id };
};

const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  intentVersion: 1, rationale: "Duplicate claims cause rework.",
  successCriteria: [
    { description: "duplicate_claim_count = 0", measurement: "Count duplicates", target: "= 0" },
    { description: "Audited", measurement: "Change log entry exists" },
  ],
};

const callTool = async (app: App, name: string, args: object, principal?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal ? { Authorization: `Bearer ${principal}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};

test("Web APIでOutcomeを作成・一覧・詳細・更新・取消でき、Intent応答にはOutcomeが埋め込まれない", async () => {
  const { database, app } = await setup();
  const { projectId, workspaceId, intentId } = await createProjectAndIntent(app);
  const base = `/api/workspaces/${workspaceId}/intents/${intentId}/outcomes`;

  const created = await send(app, "POST", base, JSON.stringify(outcomeInput));
  assert.equal(created.status, 201);
  const { outcome } = (await created.json()) as OutcomeBody;
  assert.equal(outcome.status, "active");
  assert.equal(outcome.intentId, intentId);
  assert.deepEqual(outcome.successCriteria.map((item) => item.position), [0, 1]);

  const listed = (await (await app.request(base)).json()) as { outcomes: unknown[] };
  assert.deepEqual(listed.outcomes, [outcome]);
  assert.deepEqual(((await (await app.request(`${base}/${outcome.id}`)).json()) as OutcomeBody).outcome, outcome);

  const patched = await send(app, "PATCH", `${base}/${outcome.id}`, JSON.stringify({ title: "Renamed", hypothesis: "Because" }));
  assert.equal(patched.status, 200);
  const patchedOutcome = ((await patched.json()) as OutcomeBody).outcome;
  assert.equal(patchedOutcome.title, "Renamed");
  assert.equal(patchedOutcome.hypothesis, "Because");
  assert.deepEqual(patchedOutcome.successCriteria, outcome.successCriteria);

  const cancelled = await send(app, "POST", `${base}/${outcome.id}/cancel`, JSON.stringify({ reason: "Wrong metric" }));
  assert.equal(cancelled.status, 200);
  const cancelledOutcome = ((await cancelled.json()) as OutcomeBody).outcome;
  assert.equal(cancelledOutcome.status, "cancelled");
  assert.equal(cancelledOutcome.cancelReason, "Wrong metric");

  const intent = ((await (await app.request(`/api/workspaces/${workspaceId}/intents/${intentId}`)).json()) as { intent: object }).intent;
  assert.deepEqual(Object.keys(intent).sort(), [
    "abandonedReason", "audience", "background", "completionDefinition", "constraints", "createdAt", "desiredState", "id", "meaningVersion", "status",
    "targetDate", "title", "updatedAt", "version", "workspaceId",
  ]);
  await database.destroy();
});

test("Web APIのエラー: 400は配列位置付きのpath、404はID種別、409はstatus/fixedFields", async () => {
  const { database, app } = await setup();
  const { projectId, workspaceId, intentId } = await createProjectAndIntent(app);
  const base = `/api/workspaces/${workspaceId}/intents/${intentId}/outcomes`;

  const invalid = await send(app, "POST", base, JSON.stringify({ ...outcomeInput, successCriteria: [{ description: "d", measurement: " " }] }));
  assert.equal(invalid.status, 400);
  const invalidBody = (await invalid.json()) as ErrorBody;
  assert.equal(invalidBody.error.code, "VALIDATION_ERROR");
  assert.equal(invalidBody.error.issues?.[0]?.path, "successCriteria.0.measurement");
  const malformed = await send(app, "POST", base, "{not json");
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as ErrorBody).error.message, "Outcome input is invalid");
  assert.deepEqual(((await (await app.request(base)).json()) as { outcomes: unknown[] }).outcomes, []);

  const outcome = ((await (await send(app, "POST", base, JSON.stringify(outcomeInput))).json()) as OutcomeBody).outcome;
  const fixed = await send(app, "PATCH", `${base}/${outcome.id}`, JSON.stringify({ successCriteria: [] }));
  assert.equal(fixed.status, 409);
  const fixedBody = (await fixed.json()) as ErrorBody;
  assert.equal(fixedBody.error.code, "CONFLICT");
  assert.equal(fixedBody.error.fixedFields, "successCriteria");

  // 取消の理由が無い要求（本文なしを含む）は400で、Outcomeは変わらない。
  for (const body of [undefined, "{}", JSON.stringify({ reason: " " })]) {
    const noReason = await send(app, "POST", `${base}/${outcome.id}/cancel`, body);
    assert.equal(noReason.status, 400);
  }
  const cancelled = await send(app, "POST", `${base}/${outcome.id}/cancel`, JSON.stringify({ reason: "x" }));
  assert.equal(cancelled.status, 200);
  const again = await send(app, "PATCH", `${base}/${outcome.id}`, JSON.stringify({ title: "t" }));
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as ErrorBody).error.status, "cancelled");

  const missingOutcome = await app.request(`${base}/nope`);
  assert.equal(missingOutcome.status, 404);
  assert.match(((await missingOutcome.json()) as ErrorBody).error.message, /^Outcome nope/);
  const missingIntent = await app.request(`/api/workspaces/${workspaceId}/intents/nope/outcomes`);
  assert.equal(missingIntent.status, 404);
  assert.match(((await missingIntent.json()) as ErrorBody).error.message, /^Intent nope/);
  const missingWorkspace = await app.request(`/api/workspaces/nope/intents/${intentId}/outcomes`);
  assert.equal(missingWorkspace.status, 404);
  assert.match(((await missingWorkspace.json()) as ErrorBody).error.message, /^Workspace nope/);

  // 他Workspaceの配下から参照するとID種別が区別されて404になる。
  const other = ((await (await send(app, "POST", "/api/projects", JSON.stringify({ name: "B", mission: "M" }))).json()) as { project: { workspaceId: string } }).project.workspaceId;
  const cross = await app.request(`/api/workspaces/${other}/intents/${intentId}/outcomes/${outcome.id}`);
  assert.equal(cross.status, 404);
  assert.match(((await cross.json()) as ErrorBody).error.message, /^Intent /);

  await send(app, "POST", `/api/workspaces/${workspaceId}/intents/${intentId}/abandon`);
  const afterAbandon = await send(app, "POST", base, JSON.stringify(outcomeInput));
  assert.equal(afterAbandon.status, 409);
  assert.equal(((await afterAbandon.json()) as ErrorBody).error.status, "abandoned");
  await database.destroy();
});

test("Intentの放棄はWeb APIからもactiveなOutcomeをcancelledにし、意味変更は理由付きで新しい版になる", async () => {
  const { database, app } = await setup();
  const { projectId, workspaceId, intentId } = await createProjectAndIntent(app);
  const base = `/api/workspaces/${workspaceId}/intents/${intentId}/outcomes`;
  const outcome = ((await (await send(app, "POST", base, JSON.stringify(outcomeInput))).json()) as OutcomeBody).outcome;

  const intentUrl = `/api/workspaces/${workspaceId}/intents/${intentId}`;
  const noReason = await send(app, "PATCH", intentUrl, JSON.stringify({ expectedVersion: 1, desiredState: "Changed" }));
  assert.equal(noReason.status, 400, "Outcomeを持つIntentの意味変更は理由が必須");
  const renamed = await send(app, "PATCH", intentUrl, JSON.stringify({ expectedVersion: 1, title: "Renamed" }));
  assert.equal(renamed.status, 200);
  const changed = await send(app, "PATCH", intentUrl, JSON.stringify({ expectedVersion: 2, desiredState: "Changed", reason: "Scope moved" }));
  assert.equal(changed.status, 200);
  const changedIntent = ((await changed.json()) as { intent: { version: number; meaningVersion: number } }).intent;
  assert.deepEqual([changedIntent.version, changedIntent.meaningVersion], [3, 3]);
  // 古い編集画面（版1）は競合になり、保存済みの内容を上書きしない。
  const stale = await send(app, "PATCH", intentUrl, JSON.stringify({ expectedVersion: 1, title: "Stale" }));
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as ErrorBody).error.currentVersion, "3");
  // Outcomeは作成時の版を保持し、履歴には変更主体・理由が残る。
  const keptOutcome = ((await (await app.request(`${base}/${outcome.id}`)).json()) as OutcomeBody).outcome;
  assert.equal((keptOutcome as unknown as { intentVersion: number }).intentVersion, 1);
  const revisions = ((await (await app.request(`${intentUrl}/revisions`)).json()) as { revisions: { version: number; reason: string | null; meaningChanged: boolean; desiredState: string; changedBy: string }[] }).revisions;
  assert.deepEqual(revisions.map((revision) => revision.version), [3, 2, 1]);
  assert.deepEqual([revisions[0]!.reason, revisions[0]!.meaningChanged, revisions[0]!.desiredState], ["Scope moved", true, "Changed"]);
  assert.equal(revisions[2]!.desiredState, "S");
  assert.ok(revisions.every((revision) => revision.changedBy !== ""));

  await send(app, "POST", `/api/workspaces/${workspaceId}/intents/${intentId}/abandon`, JSON.stringify({ reason: "Changed course" }));
  const after = ((await (await app.request(`${base}/${outcome.id}`)).json()) as OutcomeBody).outcome;
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancelReason, "Intent abandoned: Changed course");
  assert.deepEqual(after.successCriteria, outcome.successCriteria);
  await database.destroy();
});

test("MCPのOutcome操作はWebと同じ内容・同じ検証結果になる", async () => {
  const { database, app } = await setup();
  const { projectId, workspaceId, intentId } = await createProjectAndIntent(app);
  const base = `/api/workspaces/${workspaceId}/intents/${intentId}/outcomes`;

  await seedProjectWorkspaceGrant(database, projectId, "strat-1", "strategist");
  const viaWeb = ((await (await send(app, "POST", base, JSON.stringify(outcomeInput))).json()) as OutcomeBody).outcome;
  const got = await callTool(app, "get_outcome", { workspaceId, intentId, outcomeId: viaWeb.id });
  assert.equal(got.isError, undefined);
  assert.deepEqual(got.structuredContent.outcome, viaWeb);

  const created = await callTool(app, "create_outcome", { workspaceId, intentId, ...outcomeInput }, "strat-1");
  assert.equal(created.isError, undefined);
  const outcomeId = created.structuredContent.outcome.id as string;
  assert.deepEqual(((await (await app.request(`${base}/${outcomeId}`)).json()) as OutcomeBody).outcome, created.structuredContent.outcome);
  const listed = await callTool(app, "list_outcomes", { workspaceId, intentId });
  assert.deepEqual(listed.structuredContent.outcomes.map((item: { id: string }) => item.id), [outcomeId, viaWeb.id]);

  const updated = await callTool(app, "update_outcome", { workspaceId, intentId, outcomeId, title: "Via MCP", hypothesis: null }, "strat-1");
  assert.equal(updated.structuredContent.outcome.title, "Via MCP");
  assert.equal(((await (await app.request(`${base}/${outcomeId}`)).json()) as OutcomeBody).outcome.title, "Via MCP");

  // 固定項目はMCPでも黙って無視されず、Webと同じCONFLICTになる。
  const fixed = await callTool(app, "update_outcome", { workspaceId, intentId, outcomeId, successCriteria: [], description: "x" }, "strat-1");
  assert.equal(fixed.isError, true);
  assert.equal(fixed.structuredContent.error.code, "CONFLICT");
  assert.equal(fixed.structuredContent.error.fixedFields, "description,successCriteria");

  const invalid = await callTool(app, "create_outcome", { workspaceId, intentId, ...outcomeInput, successCriteria: [] }, "strat-1");
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "VALIDATION_ERROR");
  assert.equal(invalid.structuredContent.error.issues[0].path, "successCriteria");
  const noReason = await callTool(app, "cancel_outcome", { workspaceId, intentId, outcomeId, reason: " " }, "strat-1");
  assert.equal(noReason.structuredContent.error.code, "VALIDATION_ERROR");

  const cancelled = await callTool(app, "cancel_outcome", { workspaceId, intentId, outcomeId, reason: "Not needed" }, "strat-1");
  assert.equal(cancelled.structuredContent.outcome.status, "cancelled");
  assert.equal(((await (await app.request(`${base}/${outcomeId}`)).json()) as OutcomeBody).outcome.status, "cancelled");
  const missing = await callTool(app, "get_outcome", { workspaceId, intentId, outcomeId: "nope" });
  assert.equal(missing.structuredContent.error.code, "NOT_FOUND");
  assert.match(missing.structuredContent.error.message, /^Outcome nope/);
  await database.destroy();
});
