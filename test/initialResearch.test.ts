import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { initialResearchBudget, initialResearchRequestKey } from "../src/domain/model/InitialResearchRequest.ts";
import { runtimeEventVersion } from "../src/domain/model/RuntimeEvent.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

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
  return { database, services, app: createApp(services) };
};

type Context = Awaited<ReturnType<typeof setup>>;
type Services = Context["services"];

const seed = async (services: Services) => {
  const project = await services.createProjectUseCase.execute(projectInput);
  const intent = await services.createIntentUseCase.execute(project.id, intentInput);
  return { project, intent };
};

const rowCount = async (database: Context["database"], table: string) => {
  const { rows } = await sql<{ count: number }>`select count(*) as count from ${sql.table(table)}`.execute(database);
  return rows[0]!.count;
};

const requestsOf = (services: Services, projectId: string, intentId: string) =>
  services.listResearchRequestsUseCase.execute(projectId, { originIntentId: intentId });

const eventsOf = (services: Services, projectId: string, input: object = {}) =>
  services.listRuntimeEventsUseCase.execute(projectId, input);

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

test("Intent作成でInitial Research Requestとresearch_requestedイベントが保存され、再起動後も同じ", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-initial-research-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);

  const [request, ...others] = await requestsOf(first.services, project.id, intent.id);
  assert.equal(others.length, 0);
  assert.ok(request);
  assert.equal(request.kind, "decision");
  assert.equal(request.status, "requested");
  assert.equal(request.originIntentId, intent.id);
  assert.equal(request.originOutcomeId, null);
  assert.equal(request.requestKey, initialResearchRequestKey(intent.id));
  assert.equal(request.budgetTotal, initialResearchBudget);
  assert.equal(request.deadlineAt, null);
  assert.ok(request.question.includes(intent.title));

  const events = await eventsOf(first.services, project.id);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { ...events[0], cursor: undefined, id: undefined },
    {
      cursor: undefined,
      id: undefined,
      version: runtimeEventVersion,
      type: "research_requested",
      projectId: project.id,
      intentId: intent.id,
      researchRequestId: request.id,
      outcomeId: null,
      correlationId: request.correlationId,
      conclusion: null,
      occurredAt: events[0]!.occurredAt,
    },
  );
  assert.ok(events[0]!.correlationId.length > 0);
  await first.database.destroy();

  // 再起動（schema再初期化を含む）でRequestもイベントも増えず、同じID・cursorで取得できる。
  const restarted = await setup(path);
  assert.deepEqual(await requestsOf(restarted.services, project.id, intent.id), [request]);
  assert.deepEqual(await eventsOf(restarted.services, project.id), events);
  await initializeSchema(restarted.database);
  await initializeSchema(restarted.database);
  assert.equal(await rowCount(restarted.database, "research_request"), 1);
  assert.equal(await rowCount(restarted.database, "runtime_event"), 1);
  await restarted.database.destroy();
});

test("Web API・MCPの既存入口も同じuse caseを通り、Initial Requestを1件だけ作る", async () => {
  const { database, services, app } = await setup();
  const web = await services.createProjectUseCase.execute(projectInput);
  const created = await app.request(`/api/projects/${web.id}/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intentInput),
  });
  assert.equal(created.status, 201);
  const { intent: webIntent } = (await created.json()) as { intent: { id: string } };
  assert.equal((await requestsOf(services, web.id, webIntent.id)).length, 1);
  assert.equal((await eventsOf(services, web.id)).length, 1);

  const mcp = await services.createProjectUseCase.execute({ ...projectInput, name: "Via MCP" });
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_intent", arguments: { projectId: mcp.id, ...intentInput } },
    }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  const mcpIntent = JSON.parse(data!.slice(6)).result.structuredContent as { id: string };
  assert.equal((await requestsOf(services, mcp.id, mcpIntent.id)).length, 1);
  assert.equal((await eventsOf(services, mcp.id)).length, 1);
  await database.destroy();
});

test("Requestまたはイベントの保存に失敗すると、Intentも片方だけ残らない", async () => {
  for (const table of ["research_request", "runtime_event"]) {
    const { database, services } = await setup();
    const project = await services.createProjectUseCase.execute(projectInput);
    await sql`create trigger fail_${sql.raw(table)} before insert on ${sql.table(table)}
      begin select raise(abort, 'simulated failure'); end`.execute(database);

    await assert.rejects(services.createIntentUseCase.execute(project.id, intentInput));
    assert.equal(await rowCount(database, "intent"), 0, `${table}の失敗でIntentが残った`);
    assert.equal(await rowCount(database, "research_request"), 0);
    assert.equal(await rowCount(database, "runtime_event"), 0);

    // 失敗は一時的でも、復旧後の作成は通常どおり成功し、Intentごとに1件になる。
    await sql`drop trigger ${sql.id(`fail_${table}`)}`.execute(database);
    const intent = await services.createIntentUseCase.execute(project.id, intentInput);
    assert.equal((await requestsOf(services, project.id, intent.id)).length, 1);
    assert.equal((await eventsOf(services, project.id)).length, 1);
    await database.destroy();
  }
});

test("再送・不正な作成・archived Projectでは新しいRequestもイベントも作らない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);

  // 同じProjectへの再作成（再送を含む）はactive Intentがあるため拒否され、何も増えない。
  await assert.rejects(services.createIntentUseCase.execute(project.id, intentInput), rejectsWith("CONFLICT"));
  await assert.rejects(services.createIntentUseCase.execute(project.id, { title: " ", desiredState: "" }), rejectsWith("VALIDATION_ERROR"));
  assert.equal(await rowCount(database, "research_request"), 1);
  assert.equal(await rowCount(database, "runtime_event"), 1);

  const other = await services.createProjectUseCase.execute({ ...projectInput, name: "Other" });
  await services.archiveProjectUseCase.execute(other.id, { reason: "Done" });
  await assert.rejects(services.createIntentUseCase.execute(other.id, intentInput), rejectsWith("CONFLICT"));
  await assert.rejects(services.createIntentUseCase.execute("missing", intentInput), rejectsWith("NOT_FOUND"));
  assert.equal(await rowCount(database, "intent"), 1);
  assert.equal(await rowCount(database, "research_request"), 1);
  assert.equal(await rowCount(database, "runtime_event"), 1);
  assert.deepEqual(await eventsOf(services, other.id), []);
  assert.equal((await requestsOf(services, project.id, intent.id)).length, 1);
  await database.destroy();
});

test("completed / insufficient / not_neededはStrategistを起動できるresearch_completedイベントになる", async () => {
  const { database, services } = await setup();
  const conclusions = ["completed", "insufficient", "not_needed"] as const;
  for (const conclusion of conclusions) {
    const { project, intent } = await seed(services);
    const [request] = await requestsOf(services, project.id, intent.id);
    if (conclusion === "completed") {
      const result = await services.registerResearchResultUseCase.execute(project.id, request!.id, resultInput());
      await services.registerResearchSynthesisUseCase.execute(
        project.id,
        request!.id,
        synthesisInput(result.findings.map(({ id }) => id)),
      );
      // 確定前はまだResearcher起動のイベントだけで、Strategistを起動する条件は無い。
      assert.deepEqual((await eventsOf(services, project.id)).map(({ type }) => type), ["research_requested"]);
    }
    const closed = await services.completeResearchRequestUseCase.execute(
      project.id,
      request!.id,
      conclusion === "completed" ? { conclusion } : { conclusion, stopReason: "Stopped with a reason" },
    );
    assert.equal(closed.status, conclusion);

    const events = await eventsOf(services, project.id);
    assert.deepEqual(events.map(({ type }) => type), ["research_requested", "research_completed"]);
    const completed = events[1]!;
    assert.equal(completed.conclusion, conclusion);
    assert.equal(completed.version, runtimeEventVersion);
    assert.equal(completed.projectId, project.id);
    assert.equal(completed.intentId, intent.id);
    assert.equal(completed.researchRequestId, request!.id);
    // Initial Requestの作成時と同じcorrelationIdで、Runtimeが一連の流れとして追える。
    assert.equal(completed.correlationId, events[0]!.correlationId);
    assert.ok(completed.cursor > events[0]!.cursor);

    // 確定の再送は状態違反として拒否され、イベントは増えない。
    await assert.rejects(
      services.completeResearchRequestUseCase.execute(project.id, request!.id, { conclusion: "not_needed", stopReason: "again" }),
      rejectsWith("CONFLICT"),
    );
    assert.equal((await eventsOf(services, project.id)).length, 2);
  }
  await database.destroy();
});

test("cancelled・確定できない完了・放棄されたIntentのRequestはresearch_completedイベントを作らない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const [request] = await requestsOf(services, project.id, intent.id);

  // ResultとSynthesisが無いcompletedは確定できず、イベントも作らない。
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.id, request!.id, { conclusion: "completed" }),
    rejectsWith("CONFLICT"),
  );
  assert.equal((await eventsOf(services, project.id)).length, 1);

  await services.cancelResearchRequestUseCase.execute(project.id, request!.id, { reason: "Not needed anymore" });
  assert.deepEqual((await eventsOf(services, project.id)).map(({ type }) => type), ["research_requested"]);

  // Intentを放棄すると未終了のRequestは取り消され、以後の確定もイベントにならない。
  const other = await seed(services);
  const [pending] = await requestsOf(services, other.project.id, other.intent.id);
  await services.abandonIntentUseCase.execute(other.project.id, other.intent.id, { reason: "Changed" });
  const [afterAbandon] = await requestsOf(services, other.project.id, other.intent.id);
  assert.equal(afterAbandon!.id, pending!.id);
  assert.equal(afterAbandon!.status, "cancelled");
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(other.project.id, pending!.id, { conclusion: "not_needed", stopReason: "x" }),
    rejectsWith("CONFLICT"),
  );
  assert.deepEqual((await eventsOf(services, other.project.id)).map(({ type }) => type), ["research_requested"]);

  // 放棄後に新しいIntentを作れば、そのIntentのInitial Requestとイベントだけが増える。
  const next = await services.createIntentUseCase.execute(other.project.id, intentInput);
  assert.equal((await requestsOf(services, other.project.id, next.id)).length, 1);
  assert.equal((await eventsOf(services, other.project.id)).length, 2);
  await database.destroy();
});

test("archived Projectでは確定してもイベントを作らず、別Projectのイベントは取得できない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const other = await seed(services);
  const [request] = await requestsOf(services, project.id, intent.id);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.id, request!.id, { conclusion: "not_needed", stopReason: "x" }),
    rejectsWith("CONFLICT"),
  );
  assert.deepEqual((await eventsOf(services, project.id)).map(({ type }) => type), ["research_requested"]);

  const otherEvents = await eventsOf(services, other.project.id);
  assert.deepEqual(otherEvents.map(({ projectId }) => projectId), [other.project.id]);
  await assert.rejects(eventsOf(services, "missing"), rejectsWith("NOT_FOUND"));
  await database.destroy();
});

test("イベントはcursorの昇順で、afterCursorとlimitで差分を取得できる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const [request] = await requestsOf(services, project.id, intent.id);
  await services.completeResearchRequestUseCase.execute(project.id, request!.id, { conclusion: "not_needed", stopReason: "Known" });

  const all = await eventsOf(services, project.id);
  assert.equal(all.length, 2);
  assert.ok(all[0]!.cursor < all[1]!.cursor);
  assert.deepEqual(await eventsOf(services, project.id, { afterCursor: all[0]!.cursor }), [all[1]]);
  assert.deepEqual(await eventsOf(services, project.id, { afterCursor: all[1]!.cursor }), []);
  assert.deepEqual(await eventsOf(services, project.id, { limit: 1 }), [all[0]]);
  await assert.rejects(eventsOf(services, project.id, { afterCursor: -1 }), rejectsWith("VALIDATION_ERROR"));
  await assert.rejects(eventsOf(services, project.id, { limit: 0 }), rejectsWith("VALIDATION_ERROR"));
  await database.destroy();
});

test("導入前のActive Intentは再初期化でInitial Requestを1件だけ補い、Intent・Outcomeを壊さない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-initial-research-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);
  const outcome = await first.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  const abandoned = await seed(first.services);
  await first.services.abandonIntentUseCase.execute(abandoned.project.id, abandoned.intent.id, { reason: "Old" });
  const archived = await seed(first.services);
  await first.services.archiveProjectUseCase.execute(archived.project.id, { reason: "Old" });

  // Initial Request導入前の状態: Intentだけがあり、Request・イベントが無い。
  await sql`delete from runtime_event`.execute(first.database);
  await sql`delete from research_request`.execute(first.database);
  assert.deepEqual(await requestsOf(first.services, project.id, intent.id), []);
  // 導入前のIntentとOutcomeは、Requestが無くても参照・更新できる。
  assert.deepEqual(await first.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id), outcome);
  await first.database.destroy();

  const restarted = await setup(path);
  const [backfilled, ...rest] = await requestsOf(restarted.services, project.id, intent.id);
  assert.equal(rest.length, 0);
  assert.equal(backfilled!.requestKey, initialResearchRequestKey(intent.id));
  assert.equal(backfilled!.status, "requested");
  const events = await eventsOf(restarted.services, project.id);
  assert.deepEqual(events.map(({ type, researchRequestId }) => [type, researchRequestId]), [["research_requested", backfilled!.id]]);
  assert.deepEqual(await restarted.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id), outcome);
  assert.equal((await restarted.services.getIntentUseCase.execute(project.id, intent.id)).id, intent.id);

  // 放棄済みのIntentとarchivedのProjectには補わない。
  assert.equal(await rowCount(restarted.database, "research_request"), 1);
  assert.equal(await rowCount(restarted.database, "runtime_event"), 1);

  // 何度再初期化しても重複しない。取り消したRequestも再作成しない。
  await restarted.services.cancelResearchRequestUseCase.execute(project.id, backfilled!.id, { reason: "Runtime decided" });
  await initializeSchema(restarted.database);
  await initializeSchema(restarted.database);
  assert.equal(await rowCount(restarted.database, "research_request"), 1);
  assert.equal(await rowCount(restarted.database, "runtime_event"), 1);
  assert.equal((await restarted.services.getResearchRequestUseCase.execute(project.id, backfilled!.id)).request.status, "cancelled");

  // 補った後も、既存の入口で追加のResearch Requestを作れる。
  const extra = await restarted.services.createResearchRequestUseCase.execute(project.id, {
    requestKey: "extra",
    kind: "decision",
    originIntentId: intent.id,
    question: "More?",
    scope: "Scope",
    completionCondition: "Done",
    budgetTotal: 10,
  });
  assert.equal(extra.status, "requested");
  assert.equal((await eventsOf(restarted.services, project.id)).length, 2);
  await restarted.database.destroy();
});
