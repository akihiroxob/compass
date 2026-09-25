import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * additional_research Direction Decisionから追加Research RequestとRuntimeイベントを作る確定経路（Task 32）。
 * Runtime（polling・Researcher起動）は未接続で、ここでRuntimeとして振る舞うのはtest内のMCP呼び出しだけ。
 * Lv6の自律運転の実証ではない。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Services = ReturnType<typeof createApplicationServices>;

const start = 1_800_000_000_000;

const setup = async (clock: () => number = () => start) => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, clock);
  return { database, services, app: await createSignedInApp(database, services) };
};

type Context = Awaited<ReturnType<typeof setup>>;

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const rpc = async (app: App, method: string, params: object, principal?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const callTool = async (app: App, name: string, args: object, principal?: string): Promise<ToolResult> =>
  (await rpc(app, "tools/call", { name, arguments: args }, principal)).result;

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return result.structuredContent.error as { code: string; message: string } & Record<string, any>;
};

const grant = async (app: App, projectId: string, principalId: string, role: string) => {
  const response = await send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });
  assert.ok(response.status === 200 || response.status === 201);
};

const seed = async (services: Services, name = "Compass") => {
  const project = await services.createProjectUseCase.execute({ name, mission: "Keep direction explicit" });
  const intent = await services.createIntentUseCase.execute(project.id, {
    title: `Agents improve ${name}`,
    desiredState: "Agents improve the software.",
  });
  return { project, intent };
};

const plan = {
  question: "Does lease renewal cause a renew storm?",
  scope: "Lease-based claiming in the target Repository.",
  completionCondition: "The renew-storm risk is confirmed or ruled out with evidence.",
  budgetTotal: 50,
};

const decisionArgs = (projectId: string, intentId: string, overrides: object = {}) => ({
  projectId,
  intentId,
  type: "additional_research",
  judgment: "Evidence is insufficient to choose an Outcome",
  reason: "The renew-storm risk is unresolved",
  options: ["Proceed now", "Research first"],
  research: plan,
  requestKey: "additional-1",
  runRef: "strategist-run-1",
  ...overrides,
});

const counts = async ({ database }: Context) => {
  const count = async (table: "direction_decision" | "research_request" | "runtime_event") =>
    Number((await sql<{ n: number }>`select count(*) as n from ${sql.table(table)}`.execute(database)).rows[0]!.n);
  return {
    decisions: await count("direction_decision"),
    requests: await count("research_request"),
    events: await count("runtime_event"),
  };
};

const fetchEvents = async (app: App, projectId: string) =>
  (await callTool(app, "fetch_runtime_events", { projectId }, "runtime-a")).structuredContent.events as Array<
    Record<string, any>
  >;

const seedActors = async (app: App, projectId: string) => {
  await grant(app, projectId, "strat-1", "strategist");
  await grant(app, projectId, "runtime-a", "runtime");
};

test("additional_researchはDecision・Request・research_requestedイベントを一貫した相関IDで保存し、Runtimeが取得できる", async () => {
  const context = await setup();
  const { app, services } = context;
  const { project, intent } = await seed(services);
  await seedActors(app, project.id);
  const before = await counts(context);
  assert.deepEqual(before, { decisions: 0, requests: 1, events: 1 }); // Initial Requestだけ。

  const created = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
  assert.equal(created.isError, undefined);
  const { decision, researchRequest } = created.structuredContent;

  assert.equal(decision.type, "additional_research");
  assert.equal(decision.principalId, "strat-1");
  assert.equal(researchRequest.kind, "decision");
  assert.equal(researchRequest.status, "requested");
  assert.equal(researchRequest.originIntentId, intent.id);
  assert.equal(researchRequest.originOutcomeId, null);
  assert.equal(researchRequest.requestKey, `additional-research:${decision.id}`);
  assert.equal(researchRequest.question, plan.question);
  assert.equal(researchRequest.scope, plan.scope);
  assert.equal(researchRequest.completionCondition, plan.completionCondition);
  assert.equal(researchRequest.budgetTotal, 50);
  assert.equal(researchRequest.budgetUsed, 0);
  assert.equal(researchRequest.deadlineAt, null);
  assert.equal(researchRequest.correlationId, `decision:${decision.id}`);
  assert.deepEqual(await counts(context), { decisions: 1, requests: 2, events: 2 });

  // RuntimeはTask 31の入口から、Initial Requestに続く新しいイベントを取得できる。
  const events = await fetchEvents(app, project.id);
  assert.equal(events.length, 2);
  const event = events[1]!;
  assert.equal(event.type, "research_requested");
  assert.equal(event.projectId, project.id);
  assert.equal(event.intentId, intent.id);
  assert.equal(event.researchRequestId, researchRequest.id);
  assert.equal(event.correlationId, `decision:${decision.id}`);
  assert.equal(event.conclusion, null);

  // Web APIのRequest詳細からも、相関IDで決めたDecisionへ遡れる。
  const detail = await (await send(app, "GET", `/api/projects/${project.id}/research-requests/${researchRequest.id}`)).json();
  assert.equal(detail.detail.request.correlationId, `decision:${decision.id}`);
  await context.database.destroy();
});

test("同じrequestKeyの再送はDecision・Request・イベントを重複作成せず、異なるpayloadはCONFLICTになる", async () => {
  const context = await setup();
  const { app, services } = context;
  const { project, intent } = await seed(services);
  await seedActors(app, project.id);

  const first = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
  const after = await counts(context);

  const replayed = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
  assert.equal(replayed.isError, undefined);
  assert.equal(replayed.structuredContent.decision.id, first.structuredContent.decision.id);
  assert.equal(replayed.structuredContent.researchRequest.id, first.structuredContent.researchRequest.id);
  assert.deepEqual(await counts(context), after);

  for (const changed of [
    { research: { ...plan, budgetTotal: 51 } },
    { research: { ...plan, deadlineAt: start + 60_000 } },
    { research: { ...plan, question: "A different question?" } },
    { reason: "A different reason" },
  ]) {
    const conflicting = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id, changed), "strat-1");
    assert.equal(errorOf(conflicting).code, "CONFLICT");
    assert.equal(errorOf(conflicting).requestKey, "additional-1");
  }
  assert.deepEqual(await counts(context), after);
  await context.database.destroy();
});

test("期限が過ぎた後でも、同じ入力の再送は作成済みのDecisionとRequestを返す。新規の過去期限は拒否する", async () => {
  let now = start;
  const context = await setup(() => now);
  const { app, services } = context;
  const { project, intent } = await seed(services);
  await seedActors(app, project.id);

  const args = decisionArgs(project.id, intent.id, { research: { ...plan, deadlineAt: start + 1_000 } });
  const first = await callTool(app, "create_direction_decision", args, "strat-1");
  assert.equal(first.structuredContent.researchRequest.deadlineAt, start + 1_000);
  const created = await counts(context);

  now = start + 5_000;
  const replayed = await callTool(app, "create_direction_decision", args, "strat-1");
  assert.equal(replayed.isError, undefined);
  assert.equal(replayed.structuredContent.researchRequest.id, first.structuredContent.researchRequest.id);

  const past = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, { research: { ...plan, deadlineAt: now }, requestKey: "additional-past" }),
    "strat-1",
  );
  const error = errorOf(past);
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.ok(JSON.stringify(error).includes("research.deadlineAt"));
  assert.deepEqual(await counts(context), created);
  await context.database.destroy();
});

test("research入力はadditional_researchだけが必須で、不正な予算・期限・空の計画はDecisionもRequestも作らない", async () => {
  const context = await setup();
  const { app, services } = context;
  const { project, intent } = await seed(services);
  await seedActors(app, project.id);
  const before = await counts(context);

  const invalid: Array<[string, object]> = [
    ["research欠落", { research: undefined }],
    ["予算0", { research: { ...plan, budgetTotal: 0 } }],
    ["予算が上限超過", { research: { ...plan, budgetTotal: 10_001 } }],
    ["予算が小数", { research: { ...plan, budgetTotal: 1.5 } }],
    ["予算が文字列", { research: { ...plan, budgetTotal: "50" } }],
    ["期限が0以下", { research: { ...plan, deadlineAt: 0 } }],
    ["期限が小数", { research: { ...plan, deadlineAt: start + 0.5 } }],
    ["Questionが空", { research: { ...plan, question: "  " } }],
    ["scopeが空", { research: { ...plan, scope: "" } }],
    ["completionConditionが空", { research: { ...plan, completionCondition: "" } }],
    ["additional_research以外のtypeにresearch", { type: "intent_complete" }],
  ];
  for (const [label, overrides] of invalid) {
    const result = await callTool(
      app,
      "create_direction_decision",
      decisionArgs(project.id, intent.id, { ...overrides, requestKey: `invalid-${label}` }),
      "strat-1",
    );
    // 型が合わない入力（小数・文字列）はMCP SDKのschemaが先に拒否する。それ以外はapplication層のVALIDATION_ERROR。
    assert.equal(result.isError, true, label);
    if (result.structuredContent) assert.equal(errorOf(result).code, "VALIDATION_ERROR", label);

    // 入口に依らず、application層自身が全ての不正入力を拒否する。
    await assert.rejects(
      services.createDirectionDecisionUseCase.execute(project.id, "strat-1", {
        ...decisionArgs(project.id, intent.id, { ...overrides, requestKey: `invalid-${label}` }),
        projectId: undefined,
      }),
      (error: Error) => error.name === "ValidationError",
      label,
    );
  }
  assert.deepEqual(await counts(context), before);

  // additional_research以外は従来どおりresearchなしで記録でき、Requestもイベントも作らない。
  const complete = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, { type: "intent_abandon", research: undefined, requestKey: "complete-1" }),
    "strat-1",
  );
  assert.equal(complete.isError, undefined);
  assert.equal(complete.structuredContent.researchRequest, null);
  assert.deepEqual(await counts(context), { ...before, decisions: 1 });
  await context.database.destroy();
});

test("archived Project・非Active Intent・別Project参照・Researcher / Runtime Grantによる確定を拒否する", async () => {
  const context = await setup();
  const { app, services } = context;
  const { project, intent } = await seed(services);
  const other = await seed(services, "Other");
  await seedActors(app, project.id);
  await grant(app, project.id, "researcher-a", "researcher");
  await grant(app, other.project.id, "strat-other", "strategist");

  // ResearcherやRuntimeはDirectionを決められない。別ProjectのStrategist Grantも使えない。
  for (const principal of ["researcher-a", "runtime-a", "strat-other"]) {
    const denied = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), principal);
    assert.equal(errorOf(denied).code, "FORBIDDEN", principal);
  }
  const anonymous = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id));
  assert.equal(errorOf(anonymous).code, "UNAUTHENTICATED");

  // 別ProjectのIntent・Synthesis参照は、application層で拒否する。
  const foreignIntent = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, other.intent.id, { requestKey: "foreign-intent" }),
    "strat-1",
  );
  assert.equal(errorOf(foreignIntent).code, "NOT_FOUND");
  const foreignSynthesis = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, {
      usedSyntheses: [{ synthesisId: "synthesis-in-another-project", version: 1 }],
      requestKey: "foreign-synthesis",
    }),
    "strat-1",
  );
  assert.equal(errorOf(foreignSynthesis).code, "VALIDATION_ERROR");
  assert.equal((await counts(context)).decisions, 0);
  assert.equal((await counts(context)).requests, 2); // 各ProjectのInitial Request。

  // 非Active Intent。
  await services.abandonIntentUseCase.execute(project.id, intent.id, { reason: "Superseded" });
  const eventsBefore = await counts(context);
  const abandoned = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
  assert.equal(errorOf(abandoned).code, "CONFLICT");
  assert.equal(errorOf(abandoned).status, "abandoned");
  assert.deepEqual(await counts(context), eventsBefore);

  // archived Project（再送の判定より先に拒否される）。
  const active = await services.createIntentUseCase.execute(project.id, { title: "Next", desiredState: "Next state" });
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  const archivedBefore = await counts(context);
  const archived = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, active.id, { requestKey: "after-archive" }),
    "strat-1",
  );
  assert.equal(errorOf(archived).code, "CONFLICT");
  assert.equal(errorOf(archived).projectStatus, "archived");
  assert.deepEqual(await counts(context), archivedBefore);
  await context.database.destroy();
});

test("Decision・Request・イベントのいずれかの保存に失敗すると何も残らず、復旧後の再送で1件ずつ作られる", async () => {
  for (const table of ["direction_decision", "research_request", "runtime_event"]) {
    const context = await setup();
    const { app, services, database } = context;
    const { project, intent } = await seed(services);
    await seedActors(app, project.id);
    const before = await counts(context);

    // 追加Researchの保存経路だけを失敗させるため、seed後にtriggerを置く。
    await sql`create trigger fail_${sql.raw(table)} before insert on ${sql.table(table as "runtime_event")}
      begin select raise(abort, 'simulated failure'); end`.execute(database);
    const failed = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
    assert.equal(failed.isError, true, `${table}の失敗が成功として扱われた`);
    assert.deepEqual(await counts(context), before, `${table}の失敗で部分保存が残った`);

    // 失敗は一時的でも、同じrequestKeyの再送は通常どおり成功し、1件ずつになる。
    await sql`drop trigger ${sql.id(`fail_${table}`)}`.execute(database);
    const retried = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
    assert.equal(retried.isError, undefined);
    assert.deepEqual(await counts(context), { decisions: 1, requests: 2, events: 2 });
    assert.equal((await fetchEvents(app, project.id)).length, 2);
    await database.destroy();
  }
});

test("追加Requestの終了でresearch_completedが同じ相関IDで出て、Strategist Contextから追加Requestを追跡できる", async () => {
  const context = await setup();
  const { app, services } = context;
  const { project, intent } = await seed(services);
  await seedActors(app, project.id);
  await grant(app, project.id, "researcher-a", "researcher");

  const created = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
  const { decision, researchRequest } = created.structuredContent;

  // ResearcherはRuntimeに起動され、追加Requestを自分の調査対象として取得できる。
  const researcherContext = await callTool(
    app,
    "get_researcher_context",
    { projectId: project.id, requestId: researchRequest.id },
    "researcher-a",
  );
  assert.equal(researcherContext.isError, undefined);
  assert.equal(researcherContext.structuredContent.request.question, plan.question);
  const closed = await services.completeResearchRequestUseCase.execute(project.id, researchRequest.id, {
    conclusion: "insufficient",
    stopReason: "No public evidence found",
  });
  assert.equal(closed.status, "insufficient");

  const events = await fetchEvents(app, project.id);
  const completed = events.find((event) => event.type === "research_completed" && event.researchRequestId === researchRequest.id);
  assert.ok(completed);
  assert.equal(completed.correlationId, `decision:${decision.id}`);
  assert.equal(completed.conclusion, "insufficient");

  const strategistContext = await callTool(app, "get_strategist_context", { projectId: project.id }, "strat-1");
  const ids = strategistContext.structuredContent.research.requests.map((item: { id: string }) => item.id);
  assert.ok(ids.includes(researchRequest.id));
  await context.database.destroy();
});
