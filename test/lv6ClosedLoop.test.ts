import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Kysely } from "kysely";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import type { Database } from "../src/infrastructure/database/schema.ts";
import { GoogleOidcIdentityProvider } from "../src/infrastructure/identity/GoogleOidcIdentityProvider.ts";
import { assertBootstrapConfigured, loadHumanAuthConfig } from "../src/presentation/http/humanAuthConfig.ts";
import {
  outcomePlans,
  Runtime,
  RuntimeCrash,
  ToolError,
  withMcp,
  type Connection,
  type Faults,
  type Json,
  type RuntimeStore,
  type Tokens,
} from "./support/lv6Runtime.ts";
import { createOidcFixture } from "./support/oidcFixture.ts";

/**
 * Task 38: 空DBの統合Compass serverに対し、同一portのWeb API（Human: Google OIDC Session）と統一`/mcp`
 * （Agent / Runtime: Task 37の不透明Credential）だけを使って、Intent → Research → Outcome → Execution →
 * Evaluation → 再計画 → Intent完了までを一周させる。外部Runtimeと各Agentは`test/support/lv6Runtime.ts`の
 * 決定的なscriptで、Compassの外側からHTTP / MCPで呼ぶだけ（別Wacha serverは起動しない）。
 *
 * 実Google・LLM Agent・実GitHub / CIとは接続しない。Googleは本番のGoogleOidcIdentityProviderへ注入する
 * OIDC fixture、Evidenceの参照先は実在しないURLである。DBはassertの観測にだけ読み、操作には使わない。
 */

const publicOrigin = "https://compass.example.com";
const clientId = "client-38.apps.googleusercontent.com";
const clientSecret = "client-secret-38";
const ownerEmail = "owner@example.com";
const oidcSettings = {
  clientId,
  clientSecret,
  redirectUri: `${publicOrigin}/auth/google/callback`,
  endpoints: { authorization: "https://idp.test/authorize", token: "https://idp.test/token", jwks: "https://idp.test/jwks" },
};
const sessionCookie = "__Host-compass_session";
const claimTtlMs = 30 * 60 * 1000;

// sandbox等でloopbackへのlistenが禁止された環境では実行できない。拒否だけを理由付きでskipする。
const loopbackDenial = await new Promise<string | undefined>((resolve) => {
  const probe = createServer();
  probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EPERM" || error.code === "EACCES" ? error.code : undefined));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(undefined)));
});
const loopbackSkip = loopbackDenial ? `127.0.0.1へのlistenが拒否された（${loopbackDenial}）。sandbox外で実行すること` : false;

const listen = (app: ReturnType<typeof createApp>) =>
  new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            (server as Server).closeAllConnections();
            (server as Server).close((error) => (error ? fail(error) : done()));
          }),
      });
    });
    (server as Server).once("error", reject);
  });

/** `src/server.ts`と同じ手順（設定 → schema → services → bootstrap検査 → createApp）。違いはOIDCのfetchと時刻源だけ。 */
const startServer = async (path: string, clock: { now: number }, fixture: ReturnType<typeof createOidcFixture>) => {
  const config = loadHumanAuthConfig(
    {
      COMPASS_PUBLIC_ORIGIN: publicOrigin,
      COMPASS_GOOGLE_CLIENT_ID: clientId,
      COMPASS_GOOGLE_CLIENT_SECRET: clientSecret,
      COMPASS_INITIAL_OWNER_EMAIL: ownerEmail,
    },
    { port: 51800 },
  );
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => clock.now, {
    initialOwnerEmail: config.initialOwnerEmail,
    identityProvider: new GoogleOidcIdentityProvider(config.google!, { fetch: fixture.fetch, clock: () => clock.now, endpoints: oidcSettings.endpoints }),
  });
  assertBootstrapConfigured(config, await services.getHumanAuthBootstrapStatusUseCase.execute());
  const running = await listen(createApp(services, { humanAuth: { mode: config.mode, publicOrigin: config.publicOrigin } }));
  return {
    ...running,
    database,
    stop: async () => {
      await running.close();
      await database.destroy();
    },
  };
};

/** Web UI（api.ts）と同じくSession CookieとCSRF tokenで`/api/*`を呼ぶブラウザ。 */
const createBrowser = (baseUrl: () => string) => {
  const jar = new Map<string, string>();
  let csrfToken = "";
  const request = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(`${baseUrl()}${path}`, { ...init, redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      const value = decodeURIComponent(pair!.slice(index + 1));
      if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair!.slice(0, index));
      else jar.set(pair!.slice(0, index), value);
    }
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) as Json };
  };
  return {
    request,
    async login(fixture: ReturnType<typeof createOidcFixture>, subject: string, email: string) {
      const started = await request("/auth/google/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: publicOrigin },
        body: "",
      });
      const authorization = new URL(started.headers.get("Location")!);
      const code = `code-${crypto.randomUUID()}`;
      fixture.codes.set(code, {
        claims: fixture.claims(subject, email, authorization.searchParams.get("nonce")!),
        challenge: authorization.searchParams.get("code_challenge")!,
      });
      const callback = await request(`/auth/google/callback?${new URLSearchParams({ code, state: authorization.searchParams.get("state")! })}`);
      assert.equal(callback.headers.get("Location"), "/");
      assert.ok(jar.has(sessionCookie));
      csrfToken = (await request("/api/auth/session")).json().csrfToken;
    },
    async api(method: string, path: string, body?: unknown) {
      const response = await request(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "GET" ? {} : { Origin: publicOrigin, "X-Compass-CSRF": csrfToken }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.ok(response.status < 300, `${method} ${path}: ${response.status} ${response.text}`);
      return response.json();
    },
  };
};

const countRows = async (database: Kysely<Database>, table: keyof Database, where?: [string, string]) => {
  let query = database.selectFrom(table as "story").select((eb) => eb.fn.countAll<number>().as("n"));
  if (where) query = query.where(where[0] as "project_id", "=", where[1]);
  return Number((await query.executeTakeFirstOrThrow()).n);
};

const agentPrincipals = {
  researcher: ["researcher-1", "researcher"],
  strategist: ["strategist-1", "strategist"],
  manager: ["manager-1", "manager"],
  reviewer: ["reviewer-1", "reviewer"],
  evaluator: ["evaluator-1", "evaluator"],
} as const;
const workerPrincipals = ["worker-1", "worker-2"];

test(
  "空DBの統合Compassで、Human OIDC Sessionの初期設定後、統一/mcpだけでIntent → Research → Outcome → Execution → Evaluation → 再計画 → Intent完了が完走する",
  { skip: loopbackSkip },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "compass-lv6-"));
    const path = join(directory, "compass.db");
    const clock = { now: Date.now() };
    const fixture = createOidcFixture(clock, oidcSettings);
    let server = await startServer(path, clock, fixture);
    const originalLog = console.log;
    console.log = () => undefined; // request logを抑える（秘密の非露出はTask 44で検証済み）
    try {
      // --- Human（Google OIDC Session）がWeb API経由で初期設定する。以降、Humanの途中承認・CLI・DB操作は無い
      const owner = createBrowser(() => server.baseUrl);
      await owner.login(fixture, "owner-sub", ownerEmail);
      const { project } = await owner.api("POST", "/api/projects", {
        name: "Compass",
        mission: "Keep direction explicit",
        constraints: ["Every Task has one owner"],
        repositories: [{ name: "compass", url: "https://github.com/example/compass" }],
      });
      const projectId = project.id as string;
      const tokens = {} as Tokens;
      const issueAgent = async (principal: string, role: string) => {
        await owner.api("POST", `/api/projects/${projectId}/grants`, { principalId: principal, role });
        return { principal, token: (await owner.api("POST", `/api/projects/${projectId}/credentials`, { kind: "agent", principalId: principal })).token as string };
      };
      for (const [key, [principal, role]] of Object.entries(agentPrincipals)) {
        (tokens as Record<string, unknown>)[key] = await issueAgent(principal, role);
      }
      tokens.workers = [];
      for (const principal of workerPrincipals) tokens.workers.push(await issueAgent(principal, "worker"));
      const runtimeCredential = await owner.api("POST", `/api/projects/${projectId}/credentials`, {
        kind: "runtime",
        principalId: "runtime-1",
        scopes: ["runtime:event:read", "runtime:event:ack", "execution:change:read", "execution:evidence:write", "execution:summary:read"],
      });
      tokens.runtime = { principal: "runtime-1", token: runtimeCredential.token };

      const { intent } = await owner.api("POST", `/api/projects/${projectId}/intents`, {
        title: "Exclusive claims",
        desiredState: "No Task is worked on twice",
        completionDefinition: "An achieved Outcome verifies exclusive claims automatically",
      });

      // --- 外部Runtime（別プロセス相当）。永続化するのはstoreだけで、再起動ではin-memoryの状態を失う
      const connection: Connection = { baseUrl: () => server.baseUrl, now: () => clock.now, calls: [], dropNextResponse: new Set() };
      const store: RuntimeStore = { resumeCursor: 0, changeCursor: 0, reflected: {} };
      let outcomeConfirmedSeen = 0;
      let crashed = false;
      let hung = false;
      const faults: Faults = {
        projectIds: () => [projectId],
        // 最初のOutcome: Managerがissue_story後にtimeout → retryable_failure → 再起動で同じStoryへ収束
        managerTimeoutAfterStory: (event) => event.outcomeId && ++outcomeConfirmedSeen === 1,
        // 2つ目のOutcome: Manager完了後・ack前にRuntimeとserverが停止する → 再起動後に再配送
        crashBeforeAck: (event) => event.type === "outcome_confirmed" && outcomeConfirmedSeen === 3 && !crashed && (crashed = true),
        // 最初のresearch_completedはStrategistを並行に2回起動する（重複配送）
        duplicateDispatch: (event) => event.type === "research_completed" && event.cursor <= 2,
        // 2つ目のOutcomeのTaskは、最初のClaimを取ったworker-1が応答しなくなる
        workerHangs: (principal, task) => principal === "worker-1" && outcomeConfirmedSeen >= 3 && !task.rejectReason && !hung && (hung = true),
      };
      let runtime = new Runtime(connection, tokens, store, faults);

      // 応答消失: 最初のack・Managerのissue_story・最初のEvaluationは、requestが届いた後に応答を失い、同じ入力で再送する
      connection.dropNextResponse.add("ack_runtime_event");
      connection.dropNextResponse.add("issue_story");
      connection.dropNextResponse.add("record_outcome_evaluation");

      await assert.rejects(runtime.runUntilIdle(), RuntimeCrash);
      // --- Runtimeとserverの再起動（同じDB file・Runtimeはstoreだけを引き継ぐ）。観測用の記録だけはテストが保持する
      const crashedRuntime = runtime;
      await server.stop();
      server = await startServer(path, clock, fixture);
      runtime = new Runtime(connection, tokens, store, faults);
      await runtime.runUntilIdle();

      // worker-1がClaimしたまま応答しない。Claim期限が切れるとworker-2（またはworker-1の新しいClaim）が引き継ぐ
      const stuck = await withMcp(connection, "manager-1", tokens.manager.token, (call) => call("list_tasks", { projectId, filter: { status: ["doing"] } }));
      assert.equal(stuck.tasks.length, 1);
      assert.equal(stuck.tasks[0].assignee, "worker-1");
      clock.now += claimTtlMs + 1;
      await runtime.runUntilIdle();

      // ================= 完走の確認（統一MCP・Web APIで再取得する） =================
      const intentAfter = (await owner.api("GET", `/api/projects/${projectId}/intents/${intent.id}`)).intent;
      assert.equal(intentAfter.status, "achieved");

      const strategistContext = await withMcp(connection, "strategist-1", tokens.strategist.token, (call) => call("get_strategist_context", { projectId }));
      assert.equal(strategistContext.activeIntent, null);

      const outcomes = (await owner.api("GET", `/api/projects/${projectId}/intents/${intent.id}/outcomes`)).outcomes as Json[];
      assert.deepEqual(outcomes.map((outcome) => outcome.title).sort(), [outcomePlans.first.title, outcomePlans.observable.title].sort());
      const first = outcomes.find((outcome) => outcome.title === outcomePlans.first.title)!;
      const second = outcomes.find((outcome) => outcome.title === outcomePlans.observable.title)!;
      assert.ok(first.originDecisionId && second.originDecisionId);

      // Execution: Manager / Worker / Reviewerが統一MCPで再取得できる
      const execution = await withMcp(connection, "manager-1", tokens.manager.token, async (call) => ({
        stories: (await call("list_stories", { projectId })).stories as Json[],
        tasks: (await call("list_tasks", { projectId })).tasks as Json[],
      }));
      assert.deepEqual(execution.stories.map((story) => story.correlationId).sort(), [`outcome:${first.id}`, `outcome:${second.id}`].sort());
      for (const story of execution.stories) {
        assert.equal(story.successCriteria.length, 2);
        assert.deepEqual(story.constraints, ["Every Task has one owner"]);
      }
      assert.equal(execution.tasks.length, 2);
      assert.ok(execution.tasks.every((task) => task.status === "accepted" && task.taskKey === "implement"));
      const workerView = await withMcp(connection, "worker-2", tokens.workers[1]!.token, async (call) =>
        Promise.all(execution.tasks.map(async (task) => (await call("list_task_comments", { taskId: task.id })).comments as Json[])),
      );
      for (const comments of workerView) assert.match(comments.at(-1)!.body, /tests added/);
      const reviewerView = await withMcp(connection, "reviewer-1", tokens.reviewer.token, (call) => call("list_changes", { projectId, afterCursor: 0, limit: 500 }));
      const changeTypes = (reviewerView.changes as Json[]).map((change) => change.type);
      for (const type of ["STORY_CREATED", "TASK_CREATED", "TASK_CLAIMED", "TASK_COMPLETED", "TASK_REJECTED", "TASK_REVIEWED", "TASK_ACCEPTED", "CLAIM_EXPIRED"]) {
        assert.ok(changeTypes.includes(type), `${type} was not recorded: ${changeTypes.join(",")}`);
      }
      assert.equal(changeTypes.filter((type) => type === "TASK_REJECTED").length, 2, "each Task was rejected once by the reviewer");
      // 期限切れClaimの引継ぎ: 応答しなくなったworker-1のClaimが失効し、別のClaimで完了した
      const secondTask = execution.tasks.find((task) => task.title.includes(second.id))!;
      const claimedBy = (reviewerView.changes as Json[]).filter((change) => change.type === "TASK_CLAIMED" && change.entityId === secondTask.id).map((change) => change.principalId);
      assert.ok(claimedBy.length >= 3, JSON.stringify(claimedBy));

      // Direction: Execution Summary・Evidence・EvaluationをRuntime / Evaluator / Strategistが再取得できる
      const summaries = await withMcp(connection, "runtime-1", tokens.runtime.token, async (call) =>
        Promise.all([first, second].map(async (outcome) => (await call("get_outcome_execution_summary", { projectId, outcomeId: outcome.id })).record as Json)),
      );
      for (const [index, record] of summaries.entries()) {
        assert.equal(record.summary.state, "accepted");
        assert.equal(record.summary.correlationId, `outcome:${[first, second][index]!.id}`);
        assert.deepEqual(record.evidence.map((item: Json) => item.kind).sort(), ["ci", "pull_request"]);
      }
      const evaluationsOf = async (outcomeId: string) =>
        (await withMcp(connection, "evaluator-1", tokens.evaluator.token, (call) => call("get_evaluator_context", { projectId, outcomeId }))).evaluations as Json[];
      const firstEvaluations = await evaluationsOf(first.id);
      const secondEvaluations = await evaluationsOf(second.id);
      assert.deepEqual(firstEvaluations.map((evaluation) => evaluation.result), ["insufficient_evidence", "insufficient_evidence"]);
      assert.deepEqual(secondEvaluations.map((evaluation) => evaluation.result), ["achieved", "insufficient_evidence"]);

      // Direction Decision: 最初のOutcome → 追加Research（最新Evaluation） → 次のOutcome → Intent完了（最新Evaluation）
      const decisions = (await owner.api("GET", `/api/projects/${projectId}/intents/${intent.id}/decisions`)).decisions as Json[];
      const byType = (type: string) => decisions.filter((decision) => decision.type === type);
      assert.equal(byType("next_outcome").length, 2);
      assert.equal(byType("additional_research").length, 1);
      assert.equal(byType("intent_complete").length, 1);
      assert.equal(byType("additional_research")[0]!.evaluationId, firstEvaluations[0]!.id);
      assert.equal(byType("intent_complete")[0]!.evaluationId, secondEvaluations[0]!.id);
      assert.equal(decisions.length, 4);

      // --- 相関ID: Research（decision:<id>）→ Outcome（outcome:<id>）→ Story / Change → Evaluation → 判断を辿れる
      const events = await withMcp(connection, "runtime-1", tokens.runtime.token, (call) => call("fetch_runtime_events", { projectId, afterCursor: 0 }));
      assert.deepEqual(events.events, [], "every event is finally acknowledged for this consumer");
      const allEvents = crashedRuntime.fetchedEvents.concat(runtime.fetchedEvents);
      // 初回（Intent起点）と追加（Direction Decision起点）のResearch Requestは、どちらもIntentに紐づき相関IDで区別できる
      const research = (await owner.api("GET", `/api/projects/${projectId}/research-requests?originIntentId=${intent.id}`)).requests as Json[];
      assert.deepEqual(research.map((request) => request.correlationId).sort(), [`decision:${byType("additional_research")[0]!.id}`, `intent:${intent.id}`].sort());
      assert.ok(research.every((request) => request.status === "completed"));
      for (const outcome of [first, second]) {
        const correlationId = `outcome:${outcome.id}`;
        const changes = (reviewerView.changes as Json[]).filter((change) => change.outcomeId === outcome.id);
        assert.ok(changes.length > 0 && changes.every((change) => change.correlationId === correlationId));
        const outcomeEvents = [...new Map(allEvents.filter((event) => event.outcomeId === outcome.id).map((event) => [event.id, event])).values()];
        assert.deepEqual([...new Set(outcomeEvents.map((event) => event.type))].sort(), ["outcome_confirmed", "outcome_evaluated"]);
        assert.ok(outcomeEvents.every((event) => event.correlationId === correlationId));
      }

      // ================= 障害系の確認 =================
      const eventRows = await server.database.selectFrom("runtime_event").selectAll().where("project_id", "=", projectId).orderBy("sequence").execute();
      const deliveries = await server.database.selectFrom("runtime_event_delivery").selectAll().execute();
      // イベント欠落なし: 全イベントがこのconsumerでprocessedに確定し、Runtimeが少なくとも1回は取得した
      assert.equal(deliveries.length, eventRows.length);
      assert.ok(deliveries.every((delivery) => delivery.consumer_id === "runtime-1" && delivery.outcome === "processed"), JSON.stringify(deliveries));
      const fetchedIds = new Set(allEvents.map((event) => event.id));
      assert.ok(eventRows.every((row) => fetchedIds.has(row.id)));
      assert.deepEqual(
        eventRows.map((row) => row.event_type),
        ["research_requested", "research_completed", "outcome_confirmed", "outcome_evaluated", "outcome_evaluated", "research_requested", "research_completed", "outcome_confirmed", "outcome_evaluated", "outcome_evaluated"],
      );
      assert.equal(store.resumeCursor, Math.max(...allEvents.map((event) => event.cursor)));

      // timeout: Managerのtimeoutはretryable_failureになり、次の試行（新しいattemptId）でprocessedになった
      const firstConfirmed = eventRows.find((row) => row.event_type === "outcome_confirmed")!;
      const attempts = await server.database.selectFrom("runtime_event_ack_attempt").selectAll().where("event_sequence", "=", firstConfirmed.sequence).execute();
      assert.deepEqual(attempts.map((attempt) => JSON.parse(attempt.input_json).outcome).sort(), ["processed", "retryable_failure"]);
      assert.equal(deliveries.find((delivery) => delivery.event_sequence === firstConfirmed.sequence)!.retry_count, 1);

      // レスポンス消失: 再送は同じ結果を返し、状態を変えなかった
      const replays = connection.calls.filter((call) => call.replayOfLostResponse);
      assert.deepEqual(replays.map((call) => call.tool).sort(), ["ack_runtime_event", "issue_story", "record_outcome_evaluation"]);
      assert.ok(replays.every((call) => call.ok));

      // 重複配送・再起動後の再配送: Strategist・Managerが同じイベントで複数回起動されても、Entityは1件ずつ
      const launches = connection.calls.filter((call) => call.tool === "decide_next_outcome");
      assert.ok(launches.length >= 3, "the first research_completed launched the Strategist twice");
      const secondConfirmed = eventRows.filter((row) => row.event_type === "outcome_confirmed")[1]!;
      const managerStoryCalls = connection.calls.filter((call) => call.tool === "issue_story" && call.args.outcomeId === second.id && !call.replayOfLostResponse);
      assert.equal(managerStoryCalls.length, 2, "the Manager was relaunched after the crash");
      // ack前に停止したイベントは、再起動前後のRuntimeがそれぞれ取得した（resumeCursorが未確定を追い越さない）
      assert.equal(crashedRuntime.fetchedEvents.filter((event) => event.id === secondConfirmed.id).length, 1);
      assert.equal(runtime.fetchedEvents.filter((event) => event.id === secondConfirmed.id).length, 1);
      assert.ok(!crashedRuntime.acks.some((ack) => ack.eventId === secondConfirmed.id), "the crashed Runtime did not ack");

      // 二重Story・二重Outcome・二重Evaluation・二重Decisionがない（DBを観測）
      assert.equal(await countRows(server.database, "story", ["project_id", projectId]), 2);
      assert.equal(await countRows(server.database, "task", ["project_id", projectId]), 2);
      assert.equal(await countRows(server.database, "outcome", ["project_id", projectId]), 2);
      assert.equal(await countRows(server.database, "outcome_evaluation", ["project_id", projectId]), 4);
      assert.equal(await countRows(server.database, "direction_decision", ["project_id", projectId]), 4);
      assert.equal(await countRows(server.database, "research_request", ["project_id", projectId]), 2);

      // 順序逆転: 古いEvaluationを根拠にした判断・古いchangeCursorの還流は状態を変えない
      await withMcp(connection, "strategist-1", tokens.strategist.token, async (call) => {
        await assert.rejects(
          call("create_direction_decision", {
            projectId,
            intentId: intent.id,
            type: "additional_research",
            evaluationId: secondEvaluations[1]!.id,
            judgment: "stale",
            reason: "stale",
            requestKey: "stale-decision",
            runRef: "stale",
            research: { question: "q", scope: "s", completionCondition: "c", budgetTotal: 1 },
          }),
          (error: unknown) => error instanceof ToolError && error.code === "CONFLICT",
        );
      });
      const stale = await withMcp(connection, "runtime-1", tokens.runtime.token, (call) =>
        call("record_execution_evidence", { projectId, outcomeId: first.id, changeCursor: 1 }),
      );
      assert.equal(stale.recorded.staleInput, true);
      assert.equal(stale.summary.state, "accepted");
      assert.equal(await countRows(server.database, "direction_decision", ["project_id", projectId]), 4);

      // HumanはWeb UIと同じAPIで結果を確認できる（同一server・同一port）
      const executionSummary = await owner.api("GET", `/api/projects/${projectId}/outcomes/${second.id}/execution-summary`);
      assert.equal(executionSummary.record.summary.state, "accepted");
      assert.equal((await owner.request("/health")).status, 200);
    } finally {
      console.log = originalLog;
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("外部Runtime・Agentのharnessは`src/`をimportせず、HTTP / MCPだけでCompassを操作する", () => {
  const harness = readFileSync(fileURLToPath(new URL("./support/lv6Runtime.ts", import.meta.url)), "utf-8");
  const imports = [...harness.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
  assert.deepEqual(imports, ["@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk/client/streamableHttp.js"]);
  assert.doesNotMatch(harness, /kysely|better-sqlite3|createApplicationServices|\/src\//);
});

// --- `npm start`と同じ`src/server.ts`を1コマンドで起動し、同一portでWeb UI・API・統一MCPを提供することを確認する
const serverEntry = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

test(
  "src/server.tsを1コマンドで空DBから起動すると、同一portで/health・/api・Web UI・統一/mcp（Direction・Execution tools）を提供する",
  { skip: loopbackSkip },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "compass-lv6-start-"));
    const port = await freePort();
    const origin = `http://localhost:${port}`;
    const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
      env: {
        PATH: process.env.PATH ?? "",
        COMPASS_DB_PATH: join(directory, "compass.db"),
        PORT: String(port),
        COMPASS_AUTH_MODE: "trusted-local",
        COMPASS_INITIAL_OWNER_EMAIL: ownerEmail,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => (output.stdout += chunk));
    child.stderr.on("data", (chunk) => (output.stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const deadline = Date.now() + 15_000;
      while (!output.stdout.includes("Compass running")) {
        assert.ok(Date.now() < deadline, `server did not start: ${output.stderr}`);
        assert.equal(child.exitCode, null, output.stderr);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const baseUrl = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      assert.equal(((await (await fetch(`${baseUrl}/api`)).json()) as Json).service, "compass");
      // Web UIはbuild済み（`npm start`の`prestart`）のときだけ配信される。未buildの環境ではHTMLの確認を省く。
      if (existsSync(fileURLToPath(new URL("../public/index.html", import.meta.url)))) {
        const html = await fetch(`${baseUrl}/`);
        assert.equal(html.status, 200);
        assert.match(await html.text(), /<div id="root">/);
      }

      // Human（開発用ログイン）がAgent Credentialを発行し、Agentは同じportの/mcpでDirection・Execution toolsを列挙する
      const jar: string[] = [];
      const login = await fetch(`${baseUrl}/auth/local/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
        body: new URLSearchParams({ email: ownerEmail }).toString(),
      });
      jar.push(...login.headers.getSetCookie().map((line) => line.split(";")[0]!));
      const cookie = jar.join("; ");
      const { csrfToken } = (await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } })).json()) as Json;
      const headers = { Cookie: cookie, Origin: origin, "X-Compass-CSRF": csrfToken, "Content-Type": "application/json" };
      const created = (await (await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Start", mission: "M" }) })).json()) as Json;
      const issued = (await (
        await fetch(`${baseUrl}/api/projects/${created.project.id}/credentials`, { method: "POST", headers, body: JSON.stringify({ kind: "agent", principalId: "agent-1" }) })
      ).json()) as Json;
      const client = new Client({ name: "lv6-start", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}`, Connection: "close" } } }),
      );
      try {
        const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
        for (const name of ["get_strategist_context", "decide_next_outcome", "record_outcome_evaluation", "fetch_runtime_events", "issue_story", "claim_task", "accept_task", "list_changes"]) {
          assert.ok(names.has(name), `${name} is not listed on the unified /mcp`);
        }
      } finally {
        await client.close();
      }
    } finally {
      child.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
