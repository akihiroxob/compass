import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { runtimeEventVersion } from "../src/domain/model/RuntimeEvent.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * 外部Runtime向けのイベント取得・ack（Task 31）。Runtimeそのもの（polling・Agent起動）は未接続で、
 * ここでRuntimeとして振る舞うのはtest内のWeb API / MCP呼び出しだけ。Lv6の自律運転の実証ではない。
 */

const start = 1_800_000_000_000;

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => start);
  return { database, services, app: await createSignedInApp(database, services) };
};

type Context = Awaited<ReturnType<typeof setup>>;
type Services = Context["services"];

const bearer = (principal: string | undefined): Record<string, string> =>
  principal === undefined ? {} : { Authorization: `Bearer ${principal}` };

const api = (app: App, method: string, path: string, principal?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(principal) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const fetchEvents = async (app: App, projectId: string, principal: string, query = "") => {
  const response = await api(app, "GET", `/api/projects/${projectId}/runtime-events${query}`, principal);
  assert.equal(response.status, 200);
  return (await response.json()) as { events: Array<Record<string, any>>; nextCursor: number; resumeCursor: number };
};

let ackSequence = 0;
/** 試行ごとに新しいattemptIdを付ける。応答消失後の再送を試すときは、bodyに同じattemptIdを明示する。 */
const ack = (app: App, projectId: string, eventId: string, principal: string, body: object) =>
  api(app, "POST", `/api/projects/${projectId}/runtime-events/${eventId}/ack`, principal, {
    attemptId: `attempt-${++ackSequence}`,
    ...body,
  });

const grantRuntime = async (app: App, projectId: string, principalId: string, role = "runtime") => {
  const response = await api(app, "POST", `/api/projects/${projectId}/grants`, undefined, { principalId, role });
  assert.ok(response.status === 200 || response.status === 201);
};

const rpc = async (app: App, method: string, params: object, principal?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...bearer(principal),
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

const seed = async (services: Services, name = "Compass") => {
  const project = await services.createProjectUseCase.execute({ name, mission: "Keep direction explicit" });
  const intent = await services.createIntentUseCase.execute(project.id, {
    title: `Agents improve ${name}`,
    desiredState: "Agents improve the software.",
  });
  const [request] = await services.listResearchRequestsUseCase.execute(project.id, { originIntentId: intent.id });
  return { project, intent, request: request! };
};

const closeRequest = (services: Services, projectId: string, requestId: string) =>
  services.completeResearchRequestUseCase.execute(projectId, requestId, {
    conclusion: "not_needed",
    stopReason: "Existing knowledge is enough",
  });

const rowCount = async (database: Context["database"], table: string) => {
  const { rows } = await sql<{ count: number }>`select count(*) as count from ${sql.table(table)}`.execute(database);
  return rows[0]!.count;
};

const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

test("未処理のresearch_requestedをcursor付きで取得しackすると、再取得で返らず、cursorから差分を再開できる", async () => {
  const { database, services, app } = await setup();
  const { project, intent, request } = await seed(services);
  await grantRuntime(app, project.id, "runtime-a");

  const first = await fetchEvents(app, project.id, "runtime-a");
  assert.equal(first.events.length, 1);
  const requested = first.events[0]!;
  assert.equal(requested.type, "research_requested");
  assert.equal(requested.projectId, project.id);
  assert.equal(requested.intentId, intent.id);
  assert.equal(requested.researchRequestId, request.id);
  assert.equal(requested.version, runtimeEventVersion);
  assert.ok(requested.correlationId.length > 0);
  assert.deepEqual([requested.retryCount, requested.lastFailureReason], [0, null]);
  assert.equal(first.nextCursor, requested.cursor);

  const acked = await ack(app, project.id, requested.id, "runtime-a", { outcome: "processed" });
  assert.equal(acked.status, 200);
  const body = (await acked.json()) as { delivery: Record<string, any>; recorded: boolean };
  assert.equal(body.recorded, true);
  assert.deepEqual(
    { ...body.delivery },
    {
      consumerId: "runtime-a",
      eventId: requested.id,
      cursor: requested.cursor,
      outcome: "processed",
      retryCount: 0,
      lastFailureReason: null,
      updatedAt: start,
    },
  );

  // ack済みは未処理として返さない。空のときはafterCursorをそのまま返し、再開位置は確定済みの末尾まで進む。
  assert.deepEqual(await fetchEvents(app, project.id, "runtime-a"), {
    events: [],
    nextCursor: 0,
    resumeCursor: requested.cursor,
  });
  assert.deepEqual(await fetchEvents(app, project.id, "runtime-a", `?afterCursor=${requested.cursor}`), {
    events: [],
    nextCursor: requested.cursor,
    resumeCursor: requested.cursor,
  });

  // Requestの確定で増えた差分だけが、前回のnextCursorから続けて返る。
  await closeRequest(services, project.id, request.id);
  const next = await fetchEvents(app, project.id, "runtime-a", `?afterCursor=${first.nextCursor}`);
  assert.deepEqual(next.events.map(({ type }) => type), ["research_completed"]);
  const completed = next.events[0]!;
  // research_completedからStrategistを起動するのに必要な項目が揃い、Researcher起動時と同じcorrelationIdを持つ。
  assert.equal(completed.conclusion, "not_needed");
  assert.equal(completed.projectId, project.id);
  assert.equal(completed.intentId, intent.id);
  assert.equal(completed.researchRequestId, request.id);
  assert.equal(completed.version, runtimeEventVersion);
  assert.equal(completed.correlationId, requested.correlationId);
  assert.equal(next.nextCursor, completed.cursor);
  await database.destroy();
});

test("limitで区切って取得でき、nextCursorで欠落・重複なく続けられる", async () => {
  const { database, services, app } = await setup();
  const { project, request } = await seed(services);
  await closeRequest(services, project.id, request.id);
  await grantRuntime(app, project.id, "runtime-a");

  const page1 = await fetchEvents(app, project.id, "runtime-a", "?limit=1");
  assert.deepEqual(page1.events.map(({ type }) => type), ["research_requested"]);
  const page2 = await fetchEvents(app, project.id, "runtime-a", `?limit=1&afterCursor=${page1.nextCursor}`);
  assert.deepEqual(page2.events.map(({ type }) => type), ["research_completed"]);
  const page3 = await fetchEvents(app, project.id, "runtime-a", `?limit=1&afterCursor=${page2.nextCursor}`);
  assert.deepEqual(page3.events, []);

  // 未ackのイベントは、afterCursorを戻せば（Runtimeが再起動してcursorを失った場合など）そのまま返る。
  assert.deepEqual((await fetchEvents(app, project.id, "runtime-a")).events.map(({ id }) => id), [
    page1.events[0]!.id,
    page2.events[0]!.id,
  ]);
  await database.destroy();
});

test("応答が失われても、取得は状態を変えずに同じイベントを返し、ackの再送は冪等になる", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(services);
  await grantRuntime(app, project.id, "runtime-a");
  const eventsBefore = await rowCount(database, "runtime_event");

  const lost = await fetchEvents(app, project.id, "runtime-a");
  const again = await fetchEvents(app, project.id, "runtime-a");
  assert.deepEqual(again, lost);
  assert.equal(await rowCount(database, "runtime_event_delivery"), 0);

  const eventId = lost.events[0]!.id;
  const first = (await (await ack(app, project.id, eventId, "runtime-a", { outcome: "processed" })).json()) as any;
  const resend = (await (await ack(app, project.id, eventId, "runtime-a", { outcome: "processed" })).json()) as any;
  assert.equal(first.recorded, true);
  assert.equal(resend.recorded, false);
  assert.deepEqual(resend.delivery, first.delivery);
  assert.equal(await rowCount(database, "runtime_event_delivery"), 1);

  // 確定済みの結果は別の結果へ変えられない。
  const conflict = await ack(app, project.id, eventId, "runtime-a", { outcome: "terminal_failure", reason: "changed my mind" });
  assert.equal(conflict.status, 409);
  const conflictBody = (await conflict.json()) as { error: Record<string, string> };
  assert.equal(conflictBody.error.code, "CONFLICT");
  assert.equal(conflictBody.error.currentOutcome, "processed");
  assert.equal(await rowCount(database, "runtime_event"), eventsBefore);
  await database.destroy();
});

test("retryable_failureは返り続けて回数と理由を伴い、processedまたはterminal_failureで確定する", async () => {
  const { database, services, app } = await setup();
  const first = await seed(services, "One");
  const second = await seed(services, "Two");
  await grantRuntime(app, first.project.id, "runtime-a");
  await grantRuntime(app, second.project.id, "runtime-a");

  const eventId = (await fetchEvents(app, first.project.id, "runtime-a")).events[0]!.id;
  const retry = (reason: string) => ack(app, first.project.id, eventId, "runtime-a", { outcome: "retryable_failure", reason });

  assert.equal((await retry("Researcher launch timed out")).status, 200);
  let pending = (await fetchEvents(app, first.project.id, "runtime-a")).events;
  assert.deepEqual(pending.map(({ id }) => id), [eventId]);
  assert.deepEqual([pending[0]!.retryCount, pending[0]!.lastFailureReason], [1, "Researcher launch timed out"]);

  assert.equal((await retry("Still unavailable")).status, 200);
  pending = (await fetchEvents(app, first.project.id, "runtime-a")).events;
  assert.deepEqual([pending[0]!.retryCount, pending[0]!.lastFailureReason], [2, "Still unavailable"]);

  // 再試行が成功した。履歴（回数）は残るが、以後は返らない。
  const done = (await (await ack(app, first.project.id, eventId, "runtime-a", { outcome: "processed" })).json()) as any;
  assert.deepEqual([done.delivery.outcome, done.delivery.retryCount, done.delivery.lastFailureReason], ["processed", 2, "Still unavailable"]);
  assert.deepEqual((await fetchEvents(app, first.project.id, "runtime-a")).events, []);

  // 終端失敗は理由を残して返らなくなる。retryable_failureからterminal_failureへも進める。
  const secondEventId = (await fetchEvents(app, second.project.id, "runtime-a")).events[0]!.id;
  await ack(app, second.project.id, secondEventId, "runtime-a", { outcome: "retryable_failure", reason: "first try" });
  const terminal = await ack(app, second.project.id, secondEventId, "runtime-a", {
    outcome: "terminal_failure",
    reason: "Unsupported event version",
  });
  assert.equal(terminal.status, 200);
  assert.deepEqual((await fetchEvents(app, second.project.id, "runtime-a")).events, []);
  const stored = await database
    .selectFrom("runtime_event_delivery")
    .select(["outcome", "retry_count", "last_failure_reason"])
    .where("project_id", "=", second.project.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(stored, { outcome: "terminal_failure", retry_count: 1, last_failure_reason: "Unsupported event version" });

  // 確定済みのterminal_failureは、processedへ変えられない。
  const overwrite = await ack(app, second.project.id, secondEventId, "runtime-a", { outcome: "processed" });
  assert.equal(overwrite.status, 409);
  await database.destroy();
});

test("consumerごとにackが独立し、別consumerのackは影響しない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(services);
  await grantRuntime(app, project.id, "runtime-a");
  await grantRuntime(app, project.id, "runtime-b");

  const eventA = (await fetchEvents(app, project.id, "runtime-a")).events[0]!;
  const eventB = (await fetchEvents(app, project.id, "runtime-b")).events[0]!;
  assert.equal(eventA.id, eventB.id);

  await ack(app, project.id, eventA.id, "runtime-a", { outcome: "processed" });
  assert.deepEqual((await fetchEvents(app, project.id, "runtime-a")).events, []);
  assert.deepEqual((await fetchEvents(app, project.id, "runtime-b")).events.map(({ id }) => id), [eventA.id]);

  // runtime-bの失敗・確定はruntime-aの記録を変えない。
  await ack(app, project.id, eventB.id, "runtime-b", { outcome: "terminal_failure", reason: "not for me" });
  assert.deepEqual((await fetchEvents(app, project.id, "runtime-b")).events, []);
  const rows = await database
    .selectFrom("runtime_event_delivery")
    .select(["consumer_id", "outcome"])
    .orderBy("consumer_id")
    .execute();
  assert.deepEqual(rows, [
    { consumer_id: "runtime-a", outcome: "processed" },
    { consumer_id: "runtime-b", outcome: "terminal_failure" },
  ]);
  await database.destroy();
});

test("別Projectのイベントは取得もackもできず、Grantは対象Projectだけに効く", async () => {
  const { database, services, app } = await setup();
  const one = await seed(services, "One");
  const two = await seed(services, "Two");
  await grantRuntime(app, one.project.id, "runtime-a");
  await grantRuntime(app, two.project.id, "runtime-b");

  const eventOne = (await fetchEvents(app, one.project.id, "runtime-a")).events[0]!;
  const eventTwo = (await fetchEvents(app, two.project.id, "runtime-b")).events[0]!;
  assert.equal(eventOne.projectId, one.project.id);
  assert.equal(eventTwo.projectId, two.project.id);

  // runtime-aはProject Twoの取得・ackにGrantが無い。
  const foreignFetch = await api(app, "GET", `/api/projects/${two.project.id}/runtime-events`, "runtime-a");
  assert.equal(foreignFetch.status, 403);
  assert.equal(await errorCode(foreignFetch), "FORBIDDEN");
  const foreignAck = await ack(app, two.project.id, eventTwo.id, "runtime-a", { outcome: "processed" });
  assert.equal(foreignAck.status, 403);

  // 自分のProjectのpathへ別Projectのeventを指定してもNOT_FOUNDで、ackは保存されない。
  const crossAck = await ack(app, one.project.id, eventTwo.id, "runtime-a", { outcome: "processed" });
  assert.equal(crossAck.status, 404);
  assert.equal(await errorCode(crossAck), "NOT_FOUND");
  assert.equal(await rowCount(database, "runtime_event_delivery"), 0);
  assert.deepEqual((await fetchEvents(app, two.project.id, "runtime-b")).events.map(({ id }) => id), [eventTwo.id]);

  // 存在しないProjectはGrantが無いのでFORBIDDEN。存在の有無を漏らさない。
  const missing = await api(app, "GET", "/api/projects/missing/runtime-events", "runtime-a");
  assert.equal(missing.status, 403);
  assert.equal(await errorCode(await ack(app, one.project.id, "missing", "runtime-a", { outcome: "processed" })), "NOT_FOUND");
  await database.destroy();
});

test("Bearerなし・形式不正・Grantなし・別Role・取消済みを拒否し、取消は次の呼出しから反映される", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(services);
  await grantRuntime(app, project.id, "researcher-a", "researcher");
  await grantRuntime(app, project.id, "strategist-a", "strategist");
  await grantRuntime(app, project.id, "runtime-a");
  const eventId = (await fetchEvents(app, project.id, "runtime-a")).events[0]!.id;
  const path = `/api/projects/${project.id}/runtime-events`;

  const anonymous = await api(app, "GET", path);
  assert.equal(anonymous.status, 401);
  assert.equal(await errorCode(anonymous), "UNAUTHENTICATED");
  assert.equal((await ack(app, project.id, eventId, undefined as never, { outcome: "processed" })).status, 401);
  const malformed = await app.request(path, { headers: { Authorization: "Basic abc" } });
  assert.equal(malformed.status, 401);
  assert.equal(await errorCode(malformed), "UNAUTHENTICATED");

  for (const principal of ["nobody", "researcher-a", "strategist-a"]) {
    const response = await api(app, "GET", path, principal);
    assert.equal(response.status, 403, principal);
    assert.equal(await errorCode(response), "FORBIDDEN");
    assert.equal((await ack(app, project.id, eventId, principal, { outcome: "processed" })).status, 403, principal);
  }
  assert.equal(await rowCount(database, "runtime_event_delivery"), 0);

  const revoked = await api(app, "DELETE", `/api/projects/${project.id}/grants/runtime/runtime-a`);
  assert.equal(revoked.status, 200);
  assert.equal((await api(app, "GET", path, "runtime-a")).status, 403);
  assert.equal((await ack(app, project.id, eventId, "runtime-a", { outcome: "processed" })).status, 403);
  assert.equal(await rowCount(database, "runtime_event_delivery"), 0);
  await database.destroy();
});

test("ackとcursor入力の不正はVALIDATION_ERRORで、何も保存しない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(services);
  await grantRuntime(app, project.id, "runtime-a");
  const eventId = (await fetchEvents(app, project.id, "runtime-a")).events[0]!.id;

  const invalidAcks: Array<[object, string]> = [
    [{}, "outcome"],
    [{ outcome: "done" }, "outcome"],
    [{ outcome: "retryable_failure" }, "reason"],
    [{ outcome: "terminal_failure", reason: "   " }, "reason"],
    [{ outcome: "terminal_failure", reason: "x".repeat(1_001) }, "reason"],
    [{ outcome: "processed", reason: "not a failure" }, "reason"],
    [{ attemptId: undefined, outcome: "processed" }, "attemptId"],
    [{ attemptId: "   ", outcome: "processed" }, "attemptId"],
  ];
  for (const [body, path] of invalidAcks) {
    const response = await ack(app, project.id, eventId, "runtime-a", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = ((await response.json()) as { error: { code: string; issues: Array<{ path: string }> } }).error;
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(error.issues.map((issue) => issue.path), [path]);
  }
  const notJson = await app.request(`/api/projects/${project.id}/runtime-events/${eventId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer runtime-a" },
    body: "{",
  });
  assert.equal(notJson.status, 400);
  assert.equal(await rowCount(database, "runtime_event_delivery"), 0);

  for (const query of ["?afterCursor=-1", "?afterCursor=abc", "?afterCursor=", "?afterCursor=1.5", "?limit=0", "?limit=501", "?limit="]) {
    const response = await api(app, "GET", `/api/projects/${project.id}/runtime-events${query}`, "runtime-a");
    assert.equal(response.status, 400, query);
    assert.equal(await errorCode(response), "VALIDATION_ERROR");
  }
  await database.destroy();
});

test("retryable_failureの同じattemptIdの再送は1回の試行に収束し、別の試行だけを数える", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-runtime-ack-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project } = await seed(first.services);
  await grantRuntime(first.app, project.id, "runtime-a");
  await grantRuntime(first.app, project.id, "runtime-b");
  const eventId = (await fetchEvents(first.app, project.id, "runtime-a")).events[0]!.id;
  const attempt = { attemptId: "try-1", outcome: "retryable_failure", reason: "timeout" };

  const recorded = (await (await ack(first.app, project.id, eventId, "runtime-a", attempt)).json()) as any;
  assert.deepEqual([recorded.recorded, recorded.delivery.retryCount], [true, 1]);
  // 1回目の応答だけが失われ、Runtimeが同じackを再送した。回数は増えず、初回の結果が返る。
  const resent = (await (await ack(first.app, project.id, eventId, "runtime-a", attempt)).json()) as any;
  assert.equal(resent.recorded, false);
  assert.deepEqual(resent.delivery, recorded.delivery);
  assert.equal((await fetchEvents(first.app, project.id, "runtime-a")).events[0]!.retryCount, 1);

  // 同じattemptIdを別の入力で使うとCONFLICTで、何も変えない。
  for (const body of [
    { ...attempt, reason: "another reason" },
    { ...attempt, outcome: "processed", reason: undefined },
  ]) {
    const conflict = await ack(first.app, project.id, eventId, "runtime-a", body);
    assert.equal(conflict.status, 409, JSON.stringify(body));
    assert.equal(await errorCode(conflict), "CONFLICT");
  }
  // attemptIdはconsumerごと。別consumerが同じattemptIdを使っても、自分の試行として記録される。
  const other = (await (await ack(first.app, project.id, eventId, "runtime-b", attempt)).json()) as any;
  assert.deepEqual([other.recorded, other.delivery.consumerId, other.delivery.retryCount], [true, "runtime-b", 1]);
  await first.database.destroy();

  // 再起動後も受付記録が残り、同じackの再送は数えない。同じ理由でも新しいattemptIdは別の試行として数える。
  const restarted = await setup(path);
  const afterRestart = (await (await ack(restarted.app, project.id, eventId, "runtime-a", attempt)).json()) as any;
  assert.deepEqual([afterRestart.recorded, afterRestart.delivery.retryCount], [false, 1]);
  const secondAttempt = (await (await ack(restarted.app, project.id, eventId, "runtime-a", { ...attempt, attemptId: "try-2" })).json()) as any;
  assert.deepEqual([secondAttempt.recorded, secondAttempt.delivery.retryCount], [true, 2]);
  assert.equal((await fetchEvents(restarted.app, project.id, "runtime-a")).events[0]!.retryCount, 2);
  await restarted.database.destroy();
});

test("resumeCursorは未ack・retryable_failureのイベントを追い越さず、再起動後の再開で欠落しない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-runtime-resume-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, request } = await seed(first.services);
  await closeRequest(first.services, project.id, request.id);
  await grantRuntime(first.app, project.id, "runtime-a");

  const fetched = await fetchEvents(first.app, project.id, "runtime-a");
  const [requested, completed] = fetched.events;
  assert.ok(requested && completed);
  // 何もackしていなければ、再開位置は最初のイベントの手前。
  assert.equal(fetched.resumeCursor, requested.cursor - 1);

  // 後のイベントだけ確定した。nextCursorは未ackの1件目を追い越すが、resumeCursorは追い越さない。
  await ack(first.app, project.id, completed.id, "runtime-a", { outcome: "processed" });
  const partial = await fetchEvents(first.app, project.id, "runtime-a");
  assert.deepEqual(partial.events.map(({ id }) => id), [requested.id]);
  assert.equal(fetched.nextCursor, completed.cursor);
  assert.equal(partial.resumeCursor, requested.cursor - 1);
  await first.database.destroy();

  // RuntimeはresumeCursorを永続化して再起動し、そこから再開する。未ackのイベントが返る。
  const restarted = await setup(path);
  const resumed = await fetchEvents(restarted.app, project.id, "runtime-a", `?afterCursor=${partial.resumeCursor}`);
  assert.deepEqual(resumed.events.map(({ id }) => id), [requested.id]);

  // retryable_failureも未確定のため、再開位置は動かない。
  await ack(restarted.app, project.id, requested.id, "runtime-a", { outcome: "retryable_failure", reason: "busy" });
  const retrying = await fetchEvents(restarted.app, project.id, "runtime-a", `?afterCursor=${partial.resumeCursor}`);
  assert.deepEqual(retrying.events.map(({ id, retryCount }) => [id, retryCount]), [[requested.id, 1]]);
  assert.equal(retrying.resumeCursor, requested.cursor - 1);
  await restarted.database.destroy();

  // すべて確定すると、再開位置はProjectの最新イベントまで進む。
  const third = await setup(path);
  await ack(third.app, project.id, requested.id, "runtime-a", { outcome: "processed" });
  const settled = await fetchEvents(third.app, project.id, "runtime-a", `?afterCursor=${partial.resumeCursor}`);
  assert.deepEqual([settled.events, settled.resumeCursor], [[], completed.cursor]);
  await third.database.destroy();
});

test("server再起動後もackとcursorの状態が残り、イベントの欠落も重複もない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-runtime-events-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, request } = await seed(first.services);
  await grantRuntime(first.app, project.id, "runtime-a");
  await grantRuntime(first.app, project.id, "runtime-b");

  const requested = (await fetchEvents(first.app, project.id, "runtime-a")).events[0]!;
  await ack(first.app, project.id, requested.id, "runtime-a", { outcome: "processed" });
  await closeRequest(first.services, project.id, request.id);
  const retried = (await fetchEvents(first.app, project.id, "runtime-a")).events[0]!;
  await ack(first.app, project.id, retried.id, "runtime-a", { outcome: "retryable_failure", reason: "before restart" });
  await first.database.destroy();

  const restarted = await setup(path);
  await initializeSchema(restarted.database);
  const afterRestart = await fetchEvents(restarted.app, project.id, "runtime-a");
  assert.deepEqual(afterRestart.events.map(({ id }) => id), [retried.id]);
  assert.deepEqual([afterRestart.events[0]!.retryCount, afterRestart.events[0]!.lastFailureReason], [1, "before restart"]);
  // 別consumerは何もackしていないため、両方のイベントを同じ順序・cursorで取得できる。
  assert.deepEqual((await fetchEvents(restarted.app, project.id, "runtime-b")).events.map(({ cursor }) => cursor), [
    requested.cursor,
    retried.cursor,
  ]);
  await ack(restarted.app, project.id, retried.id, "runtime-a", { outcome: "processed" });
  assert.equal(await rowCount(restarted.database, "runtime_event"), 2);
  assert.equal(await rowCount(restarted.database, "runtime_event_delivery"), 2);
  await restarted.database.destroy();

  const third = await setup(path);
  assert.deepEqual(await fetchEvents(third.app, project.id, "runtime-a"), {
    events: [],
    nextCursor: 0,
    resumeCursor: retried.cursor,
  });
  await third.database.destroy();
});

test("archivedのProjectでもackを記録でき、Direction・Runtime eventの内容は変わらない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(services);
  await grantRuntime(app, project.id, "runtime-a");
  const [event] = (await fetchEvents(app, project.id, "runtime-a")).events;
  const eventRowsBefore = await database.selectFrom("runtime_event").selectAll().execute();

  const archived = await api(app, "POST", `/api/projects/${project.id}/archive`, undefined, { reason: "done" });
  assert.equal(archived.status, 200);
  assert.equal((await ack(app, project.id, event!.id, "runtime-a", { outcome: "processed" })).status, 200);
  assert.deepEqual(await database.selectFrom("runtime_event").selectAll().execute(), eventRowsBefore);
  await database.destroy();
});

test("MCPのfetch_runtime_events / ack_runtime_eventも同じuse caseを通る", async () => {
  const { database, services, app } = await setup();
  const { project, request } = await seed(services);
  await grantRuntime(app, project.id, "runtime-a");
  await grantRuntime(app, project.id, "researcher-a", "researcher");

  const tools = (await rpc(app, "tools/list", {})).result.tools.map(({ name }: { name: string }) => name);
  assert.ok(tools.includes("fetch_runtime_events") && tools.includes("ack_runtime_event"));

  const fetched = (await callTool(app, "fetch_runtime_events", { projectId: project.id }, "runtime-a")).structuredContent;
  assert.equal(fetched.events.length, 1);
  const event = fetched.events[0];
  assert.equal(event.type, "research_requested");
  assert.equal(event.researchRequestId, request.id);
  // 同じconsumerは、Web APIで取得した内容と同じ。
  assert.deepEqual(fetched, await fetchEvents(app, project.id, "runtime-a"));

  const rejected = await callTool(app, "ack_runtime_event", { projectId: project.id, eventId: event.id, attemptId: "m-0", outcome: "processed" });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "UNAUTHENTICATED");
  const wrongRole = await callTool(app, "fetch_runtime_events", { projectId: project.id }, "researcher-a");
  assert.equal(wrongRole.structuredContent.error.code, "FORBIDDEN");
  const invalid = await callTool(
    app,
    "ack_runtime_event",
    { projectId: project.id, eventId: event.id, attemptId: "m-1", outcome: "retryable_failure" },
    "runtime-a",
  );
  assert.equal(invalid.structuredContent.error.code, "VALIDATION_ERROR");

  const processed = { projectId: project.id, eventId: event.id, attemptId: "m-2", outcome: "processed" };
  const acked = (await callTool(app, "ack_runtime_event", processed, "runtime-a")).structuredContent;
  assert.equal(acked.recorded, true);
  const resent = (await callTool(app, "ack_runtime_event", processed, "runtime-a")).structuredContent;
  assert.equal(resent.recorded, false);
  assert.deepEqual(resent.delivery, acked.delivery);
  const conflict = await callTool(
    app,
    "ack_runtime_event",
    { projectId: project.id, eventId: event.id, attemptId: "m-3", outcome: "terminal_failure", reason: "x" },
    "runtime-a",
  );
  assert.equal(conflict.structuredContent.error.code, "CONFLICT");
  assert.deepEqual((await callTool(app, "fetch_runtime_events", { projectId: project.id }, "runtime-a")).structuredContent.events, []);

  // Web APIでackした結果もMCPの取得に反映される（同じ永続化）。
  await closeRequest(services, project.id, request.id);
  const completed = (await fetchEvents(app, project.id, "runtime-a")).events[0]!;
  await ack(app, project.id, completed.id, "runtime-a", { outcome: "processed" });
  assert.deepEqual((await callTool(app, "fetch_runtime_events", { projectId: project.id }, "runtime-a")).structuredContent.events, []);
  await database.destroy();
});

test("get_role_instructionsはruntime Roleの文書を返し、Grantはruntimeを受け付ける", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(services);
  const result = (await callTool(app, "get_role_instructions", { role: "runtime", includeShared: true })).structuredContent;
  assert.deepEqual(result.files.map(({ path }: { path: string }) => path), ["agent/role-policy.md", "agent/runtime.md"]);
  assert.ok(result.files[1].content.includes("# Runtime Role"));
  const grant = await api(app, "POST", `/api/projects/${project.id}/grants`, undefined, { principalId: "runtime-a", role: "runtime" });
  assert.equal(grant.status, 201);
  await database.destroy();
});
