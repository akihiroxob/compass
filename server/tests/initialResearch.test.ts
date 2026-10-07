import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { runtimeEventVersion } from "@compass/direction";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

const start = 1_800_000_000_000;

const projectInput = { name: "Compass", mission: "Keep direction explicit" };
const intentInput = { title: "Agents improve software", desiredState: "Agents improve the software." };
const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [{ description: "duplicates = 0", measurement: "Count duplicates" }],
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => start);
  return { database, services, app: await createSignedInApp(database, services) };
};

type Context = Awaited<ReturnType<typeof setup>>;
type Services = Context["services"];

const seed = async (services: Services) => {
  const project = await services.createProjectUseCase.execute(projectInput);
  const intent = await services.createIntentUseCase.execute(project.workspaceId, intentInput);
  return { project, intent };
};

/** Intent作成はResearch Requestを作らない。Researchの要否はStrategistが判断し、その結果のRequestをここで模す。 */
const requestResearch = (services: Services, workspaceId: string, intentId: string, requestKey = "research-1") =>
  services.createResearchRequestUseCase.execute(workspaceId, {
    requestKey,
    kind: "decision",
    originIntentId: intentId,
    question: "What do we need to know?",
    scope: "Scope",
    completionCondition: "Strategist can decide",
    budgetTotal: 10,
  });

/** 指定したIntentのResearch Requestを作り、Intent作成後の初期状態（Request 1件・research_requested 1件）にする。 */
const seedWithResearch = async (services: Services) => {
  const seeded = await seed(services);
  await requestResearch(services, seeded.project.workspaceId, seeded.intent.id);
  return seeded;
};

const rowCount = async (database: Context["database"], table: string) => {
  const { rows } = await sql<{ count: number }>`select count(*) as count from ${sql.table(table)}`.execute(database);
  return rows[0]!.count;
};

const requestsOf = (services: Services, workspaceId: string, intentId: string) =>
  services.listResearchRequestsUseCase.execute(workspaceId, { originIntentId: intentId });

const eventsOf = (services: Services, workspaceId: string, input: object = {}) =>
  services.workspaceDirection.listRuntimeEventsUseCase.execute(workspaceId, input);

const rejectsWith = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

const resultInput = () => ({
  requestKey: "result-1",
  principalId: "researcher-a",
  runRef: "run-001",
  summary: "Leases avoid stuck claims.",
  budgetUsed: 10,
  evidenceRefs: [{ kind: "url", uri: "https://example.com/leases", retrievedAt: start }],
  findings: [{ statement: "Leases expire.", confidence: "high", observedAt: start, evidenceIndexes: [0] }],
});

const synthesisInput = (findingIds: string[]) => ({
  requestKey: "synthesis-1",
  principalId: "researcher-a",
  runRef: "run-001",
  conclusion: "Use leases.",
  findingIds,
  validAsOf: start,
});

test("Intent作成はResearch Requestもイベントも自動作成せず、再起動・再初期化でも補わない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-initial-research-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);
  assert.deepEqual(await requestsOf(first.services, project.workspaceId, intent.id), []);
  assert.deepEqual(await eventsOf(first.services, project.workspaceId), []);
  await first.database.destroy();

  const restarted = await setup(path);
  await initializeSchema(restarted.database);
  assert.equal(await rowCount(restarted.database, "research_request"), 0);
  assert.equal(await rowCount(restarted.database, "runtime_event"), 0);

  // Researchが必要とStrategistが判断した場合だけRequestとresearch_requestedイベントが保存される。
  const request = await requestResearch(restarted.services, project.workspaceId, intent.id);
  const events = await eventsOf(restarted.services, project.workspaceId);
  assert.deepEqual(
    events.map(({ type, version, intentId, researchRequestId, correlationId }) => ({ type, version, intentId, researchRequestId, correlationId })),
    [{ type: "research_requested", version: runtimeEventVersion, intentId: intent.id, researchRequestId: request.id, correlationId: request.correlationId }],
  );
  await restarted.database.destroy();
});

test("Web API・MCPのIntent作成もResearch Requestを作らない", async () => {
  const { database, services, app } = await setup();
  const web = await services.createProjectUseCase.execute(projectInput);
  const created = await app.request(`/api/workspaces/${web.workspaceId}/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intentInput),
  });
  assert.equal(created.status, 201);
  const { intent: webIntent } = (await created.json()) as { intent: { id: string } };
  assert.deepEqual(await requestsOf(services, web.workspaceId, webIntent.id), []);

  const mcp = await services.createProjectUseCase.execute({ ...projectInput, name: "Via MCP" });
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_intent", arguments: { workspaceId: mcp.workspaceId, ...intentInput } },
    }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  const mcpIntent = JSON.parse(data!.slice(6)).result.structuredContent as { id: string };
  assert.deepEqual(await requestsOf(services, mcp.workspaceId, mcpIntent.id), []);
  assert.equal(await rowCount(database, "runtime_event"), 0);
  await database.destroy();
});

test("completed / insufficient / not_neededはStrategistを起動できるresearch_completedイベントになる", async () => {
  const { database, services } = await setup();
  const conclusions = ["completed", "insufficient", "not_needed"] as const;
  for (const conclusion of conclusions) {
    const { project, intent } = await seedWithResearch(services);
    const [request] = await requestsOf(services, project.workspaceId, intent.id);
    if (conclusion === "completed") {
      const result = await services.registerResearchResultUseCase.execute(project.workspaceId, request!.id, resultInput());
      await services.registerResearchSynthesisUseCase.execute(
        project.workspaceId,
        request!.id,
        synthesisInput(result.findings.map(({ id }) => id)),
      );
      // 確定前はまだResearcher起動のイベントだけで、Strategistを起動する条件は無い。
      assert.deepEqual((await eventsOf(services, project.workspaceId)).map(({ type }) => type), ["research_requested"]);
    }
    const closed = await services.completeResearchRequestUseCase.execute(
      project.workspaceId,
      request!.id,
      conclusion === "completed" ? { conclusion } : { conclusion, stopReason: "Stopped with a reason" },
    );
    assert.equal(closed.status, conclusion);

    const events = await eventsOf(services, project.workspaceId);
    assert.deepEqual(events.map(({ type }) => type), ["research_requested", "research_completed"]);
    const completed = events[1]!;
    assert.equal(completed.conclusion, conclusion);
    assert.equal(completed.version, runtimeEventVersion);
    assert.equal(completed.workspaceId, project.workspaceId);
    assert.equal(completed.intentId, intent.id);
    assert.equal(completed.researchRequestId, request!.id);
    // Requestの作成時と同じcorrelationIdで、Runtimeが一連の流れとして追える。
    assert.equal(completed.correlationId, events[0]!.correlationId);
    assert.ok(completed.cursor > events[0]!.cursor);

    // 確定の再送は状態違反として拒否され、イベントは増えない。
    await assert.rejects(
      services.completeResearchRequestUseCase.execute(project.workspaceId, request!.id, { conclusion: "not_needed", stopReason: "again" }),
      rejectsWith("CONFLICT"),
    );
    assert.equal((await eventsOf(services, project.workspaceId)).length, 2);
  }
  await database.destroy();
});

test("cancelled・確定できない完了・放棄されたIntentのRequestはresearch_completedイベントを作らない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seedWithResearch(services);
  const [request] = await requestsOf(services, project.workspaceId, intent.id);

  // ResultとSynthesisが無いcompletedは確定できず、イベントも作らない。
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.workspaceId, request!.id, { conclusion: "completed" }),
    rejectsWith("CONFLICT"),
  );
  assert.equal((await eventsOf(services, project.workspaceId)).length, 1);

  await services.cancelResearchRequestUseCase.execute(project.workspaceId, request!.id, { reason: "Not needed anymore" });
  assert.deepEqual((await eventsOf(services, project.workspaceId)).map(({ type }) => type), ["research_requested"]);

  // Intentを放棄すると未終了のRequestは取り消され、以後の確定もイベントにならない。
  const other = await seedWithResearch(services);
  const [pending] = await requestsOf(services, other.project.workspaceId, other.intent.id);
  await services.abandonIntentUseCase.execute(other.project.workspaceId, other.intent.id, { reason: "Changed" });
  const [afterAbandon] = await requestsOf(services, other.project.workspaceId, other.intent.id);
  assert.equal(afterAbandon!.id, pending!.id);
  assert.equal(afterAbandon!.status, "cancelled");
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(other.project.workspaceId, pending!.id, { conclusion: "not_needed", stopReason: "x" }),
    rejectsWith("CONFLICT"),
  );
  assert.deepEqual((await eventsOf(services, other.project.workspaceId)).map(({ type }) => type), ["research_requested"]);

  // 放棄後に新しいIntentを作っても、Requestもイベントも増えない。
  const next = await services.createIntentUseCase.execute(other.project.workspaceId, intentInput);
  assert.deepEqual(await requestsOf(services, other.project.workspaceId, next.id), []);
  assert.equal((await eventsOf(services, other.project.workspaceId)).length, 1);
  await database.destroy();
});

test("archived Projectでは確定してもイベントを作らず、別Projectのイベントは取得できない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seedWithResearch(services);
  const other = await seedWithResearch(services);
  const [request] = await requestsOf(services, project.workspaceId, intent.id);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.workspaceId, request!.id, { conclusion: "not_needed", stopReason: "x" }),
    rejectsWith("CONFLICT"),
  );
  assert.deepEqual((await eventsOf(services, project.workspaceId)).map(({ type }) => type), ["research_requested"]);

  const otherEvents = await eventsOf(services, other.project.workspaceId);
  assert.deepEqual(otherEvents.map(({ workspaceId }) => workspaceId), [other.project.workspaceId]);
  await assert.rejects(eventsOf(services, "missing"), rejectsWith("NOT_FOUND"));
  await database.destroy();
});

test("イベントはcursorの昇順で、afterCursorとlimitで差分を取得できる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seedWithResearch(services);
  const [request] = await requestsOf(services, project.workspaceId, intent.id);
  await services.completeResearchRequestUseCase.execute(project.workspaceId, request!.id, { conclusion: "not_needed", stopReason: "Known" });

  const all = await eventsOf(services, project.workspaceId);
  assert.equal(all.length, 2);
  assert.ok(all[0]!.cursor < all[1]!.cursor);
  assert.deepEqual(await eventsOf(services, project.workspaceId, { afterCursor: all[0]!.cursor }), [all[1]]);
  assert.deepEqual(await eventsOf(services, project.workspaceId, { afterCursor: all[1]!.cursor }), []);
  assert.deepEqual(await eventsOf(services, project.workspaceId, { limit: 1 }), [all[0]]);
  await assert.rejects(eventsOf(services, project.workspaceId, { afterCursor: -1 }), rejectsWith("VALIDATION_ERROR"));
  await assert.rejects(eventsOf(services, project.workspaceId, { limit: 0 }), rejectsWith("VALIDATION_ERROR"));
  await database.destroy();
});

test("自動作成していた既存のInitial Research Requestは再初期化後も残り、Intent・Outcomeを壊さない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-initial-research-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);
  const outcome = await first.services.createOutcomeUseCase.execute(project.workspaceId, intent.id, outcomeInput);
  // 以前の自動作成と同じkey・相関IDのRequest（既存データ）を再現する。
  const legacy = await first.services.createResearchRequestUseCase.execute(project.workspaceId, {
    requestKey: `initial-research:${intent.id}`,
    kind: "decision",
    originIntentId: intent.id,
    question: `Intent「${intent.title}」を実現する最初のOutcomeを決めるために、何を知る必要があり、何が既に分かっているか。`,
    scope: "Scope",
    completionCondition: "Done",
    budgetTotal: 100,
    correlationId: `intent:${intent.id}`,
  });
  const events = await eventsOf(first.services, project.workspaceId);
  await first.database.destroy();

  const restarted = await setup(path);
  await initializeSchema(restarted.database);
  assert.deepEqual(await requestsOf(restarted.services, project.workspaceId, intent.id), [legacy]);
  assert.deepEqual(await eventsOf(restarted.services, project.workspaceId), events);
  assert.deepEqual(await restarted.services.getOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id), outcome);

  // 既存のRequestは通常のRequestとして確定でき、新しいIntentには自動作成しない。
  await restarted.services.completeResearchRequestUseCase.execute(project.workspaceId, legacy.id, { conclusion: "not_needed", stopReason: "Known" });
  assert.deepEqual((await eventsOf(restarted.services, project.workspaceId)).map(({ type }) => type), ["outcome_confirmed", "research_requested", "research_completed"]);
  const other = await seed(restarted.services);
  assert.deepEqual(await requestsOf(restarted.services, other.project.workspaceId, other.intent.id), []);
  await restarted.database.destroy();
});
