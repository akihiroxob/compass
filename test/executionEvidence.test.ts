import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * ExecutionからDirectionへのEvidence還流（Task 34）。Runtimeとして振る舞うのはtest内のMCP / Web API呼び出しだけで、
 * Runtimeの自動起動・polling・Evaluationは未接続。Lv6の自律運転の実証ではない。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Kit = Awaited<ReturnType<typeof setup>>;

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: createApp(services) };
};

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

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; message: string } & Record<string, any>;
};

const grant = async (app: App, projectId: string, principalId: string, role: string) =>
  assert.equal(
    (
      await app.request(`/api/projects/${projectId}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ principalId, role }),
      })
    ).status,
    201,
  );

const sha = (character: string) => character.repeat(40);
const pullRequest = "https://github.com/example/compass/pull/1";

const seedProject = async ({ services, app }: Kit, name = "Compass") => {
  const project = await services.createProjectUseCase.execute({ name, mission: "Keep execution guarded" });
  const intent = await services.createIntentUseCase.execute(project.id, { title: "Guarded claims", desiredState: "One owner per Task" });
  for (const [principal, role] of [["mgr", "manager"], ["wrk", "worker"], ["rev", "reviewer"], ["rt", "runtime"]] as const) {
    await grant(app, project.id, principal, role);
  }
  return { project, intent };
};

let outcomeCount = 0;
const createOutcome = async ({ services }: Kit, projectId: string, intentId: string) =>
  services.createOutcomeUseCase.execute(projectId, intentId, {
    title: `Outcome ${++outcomeCount}`,
    description: "Claims are exclusive.",
    rationale: "Rework",
    successCriteria: [{ description: "duplicate_claim_count = 0", measurement: "Count duplicate claims", target: "= 0" }],
  });

/** ManagerがOutcomeを参照するStoryを作り、Taskを`count`件作る。 */
const issueStory = async (kit: Kit, projectId: string, outcomeId: string, taskCount = 1) => {
  const n = ++outcomeCount;
  const story = ok(await callTool(kit.app, "issue_story", { projectId, title: `Story ${n}`, outcomeId, requestId: `story-${n}` }, "mgr"));
  const taskIds: string[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const task = ok(await callTool(kit.app, "issue_task", { projectId, storyId: story.id, title: `Task ${n}-${index}`, requestId: `task-${n}-${index}` }, "mgr"));
    taskIds.push(task.id);
  }
  return { storyId: story.id as string, taskIds };
};

let stepCount = 0;
const step = (label: string) => `${label}-${++stepCount}`;

/** Taskをworkerが実装し、reviewerが確認し、必要ならmanagerが受け入れる。 */
const advance = async (app: App, taskId: string, to: "in_review" | "wait_accept" | "accepted") => {
  const work = ok(await callTool(app, "claim_task", { taskId, requestId: step("claim") }, "wrk"));
  ok(await callTool(app, "add_task_comment", { taskId, claimId: work.claimId, body: "implemented", requestId: step("comment") }, "wrk"));
  ok(await callTool(app, "complete_task", { taskId, claimId: work.claimId, requestId: step("complete") }, "wrk"));
  if (to === "in_review") return;
  const review = ok(await callTool(app, "claim_review", { taskId, requestId: step("review") }, "rev"));
  ok(await callTool(app, "reviewed_task", { taskId, claimId: review.claimId, requestId: step("reviewed") }, "rev"));
  if (to === "wait_accept") return;
  const acceptance = ok(await callTool(app, "claim_acceptance", { taskId, requestId: step("accept-claim") }, "mgr"));
  ok(await callTool(app, "accept_task", { taskId, claimId: acceptance.claimId, requestId: step("accept") }, "mgr"));
};

const rejectInReview = async (app: App, taskId: string) => {
  const review = ok(await callTool(app, "claim_review", { taskId, requestId: step("review") }, "rev"));
  ok(await callTool(app, "reject_task", { taskId, claimId: review.claimId, reason: "Tests are missing", requestId: step("reject") }, "rev"));
};

const changesOf = async (app: App, projectId: string, afterCursor = 0) =>
  ok(await callTool(app, "list_changes", { projectId, afterCursor }, "rt")) as { changes: Record<string, any>[]; nextCursor: number };

/** `principal`にnullを渡すとBearerなしで呼ぶ。 */
const record = (app: App, projectId: string, outcomeId: string, args: object, principal: string | null = "rt") =>
  callTool(app, "record_execution_evidence", { projectId, outcomeId, ...args }, principal ?? undefined);

const evidence = (overrides: Record<string, unknown> = {}) => ({
  kind: "pull_request",
  uri: pullRequest,
  versionHash: sha("a"),
  observedAt: Date.now() - 1_000,
  ...overrides,
});

test("RuntimeがExecutionのChangeを増分取得して還流すると、進行に応じたExecution SummaryとEvidence参照がOutcomeへ相関付いて保存される", async () => {
  const kit = await setup();
  const { project, intent } = await seedProject(kit);
  const outcome = await createOutcome(kit, project.id, intent.id);
  const { storyId, taskIds } = await issueStory(kit, project.id, outcome.id, 2);

  // 還流前は、要約なし。
  assert.deepEqual(ok(await callTool(kit.app, "get_outcome_execution_summary", { projectId: project.id, outcomeId: outcome.id }, "rt")), { record: null });

  // RuntimeはChange Logからoutcomeを辿れる（Story・Taskの変更にoutcomeId・correlationIdが付く）。
  const first = await changesOf(kit.app, project.id);
  assert.deepEqual(first.changes.map((change) => change.type), ["STORY_CREATED", "TASK_CREATED", "TASK_CREATED"]);
  for (const change of first.changes) {
    assert.equal(change.outcomeId, outcome.id);
    assert.equal(change.correlationId, `outcome:${outcome.id}`);
  }

  const started = ok(await record(kit.app, project.id, outcome.id, { changeCursor: first.nextCursor }));
  assert.equal(started.summary.state, "incomplete");
  assert.equal(started.summary.correlationId, `outcome:${outcome.id}`);
  assert.equal(started.summary.executionCursor, first.nextCursor);
  assert.equal(started.summary.observedCursor, first.nextCursor);
  assert.equal(started.summary.stories[0].storyId, storyId);
  assert.equal(started.summary.stories[0].taskCounts.todo, 2);
  assert.deepEqual(started.recorded, { summaryChanged: true, staleInput: false, evidenceAdded: 0 });

  // 1件だけacceptedでも、残りが進行中ならincomplete。
  await advance(kit.app, taskIds[0]!, "accepted");
  const partial = await changesOf(kit.app, project.id, first.nextCursor);
  assert.ok(partial.changes.every((change) => change.outcomeId === outcome.id), "Claim・Reviewなどの変更もoutcomeへ辿れる");
  const half = ok(await record(kit.app, project.id, outcome.id, { changeCursor: partial.nextCursor }));
  assert.equal(half.summary.state, "incomplete");
  assert.equal(half.summary.stories[0].taskCounts.accepted, 1);

  // すべてacceptedになり、Evidence参照（URI・commit・観測時刻・cursor）と一緒に還流する。
  await advance(kit.app, taskIds[1]!, "accepted");
  const last = await changesOf(kit.app, project.id, partial.nextCursor);
  const observedAt = Date.now() - 5_000;
  const done = ok(
    await record(kit.app, project.id, outcome.id, {
      changeCursor: last.nextCursor,
      evidence: [
        { kind: "commit", uri: "https://github.com/example/compass/commit/" + sha("b"), versionHash: sha("b"), observedAt },
        evidence({ observedAt }),
      ],
    }),
  );
  assert.equal(done.summary.state, "accepted");
  assert.equal(done.summary.executionCursor, last.nextCursor);
  assert.deepEqual(done.recorded, { summaryChanged: true, staleInput: false, evidenceAdded: 2 });
  assert.deepEqual(
    done.evidence.map((item: Record<string, any>) => [item.kind, item.uri, item.versionHash, item.observedAt, item.sourceChangeCursor, item.principalId]),
    [
      ["commit", "https://github.com/example/compass/commit/" + sha("b"), sha("b"), observedAt, last.nextCursor, "rt"],
      ["pull_request", pullRequest, sha("a"), observedAt, last.nextCursor, "rt"],
    ],
  );

  // 保存された内容は再取得でき、Web API（Human向け読取）も同じ内容を返す。
  const fetched = ok(await callTool(kit.app, "get_outcome_execution_summary", { projectId: project.id, outcomeId: outcome.id }, "rt"));
  assert.deepEqual(fetched.record, { summary: done.summary, evidence: done.evidence });
  const viaApi = await kit.app.request(`/api/projects/${project.id}/outcomes/${outcome.id}/execution-summary`);
  assert.equal(viaApi.status, 200);
  assert.deepEqual(await viaApi.json(), { record: fetched.record });

  // Execution acceptedでも、Outcomeは変更せず、Success Criterionを充足扱いにしない。
  const stored = await kit.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id);
  assert.equal(stored.status, "active");
  assert.deepEqual(stored.successCriteria, outcome.successCriteria);
  assert.equal(JSON.stringify(done).includes("achieved"), false);
  await kit.database.destroy();
});

test("accepted / rejected / canceled / incompleteを区別する。Executionの状態は還流で変わらない", async () => {
  const kit = await setup();
  const { project, intent } = await seedProject(kit);
  const stateOf = async (outcomeId: string) => {
    const head = (await changesOf(kit.app, project.id)).nextCursor;
    return ok(await record(kit.app, project.id, outcomeId, { changeCursor: head })).summary;
  };

  // accepted
  const acceptedOutcome = await createOutcome(kit, project.id, intent.id);
  const acceptedStory = await issueStory(kit, project.id, acceptedOutcome.id);
  await advance(kit.app, acceptedStory.taskIds[0]!, "accepted");
  assert.equal((await stateOf(acceptedOutcome.id)).state, "accepted");

  // rejected（未解決の差戻しだけが残る）
  const rejectedOutcome = await createOutcome(kit, project.id, intent.id);
  const rejectedStory = await issueStory(kit, project.id, rejectedOutcome.id);
  await advance(kit.app, rejectedStory.taskIds[0]!, "in_review");
  await rejectInReview(kit.app, rejectedStory.taskIds[0]!);
  const rejected = await stateOf(rejectedOutcome.id);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.stories[0].taskCounts.rejected, 1);

  // incomplete（Taskが進行中、およびTaskがまだ無いStory）
  const runningOutcome = await createOutcome(kit, project.id, intent.id);
  const runningStory = await issueStory(kit, project.id, runningOutcome.id);
  await advance(kit.app, runningStory.taskIds[0]!, "in_review");
  assert.equal((await stateOf(runningOutcome.id)).state, "incomplete");
  const plannedOutcome = await createOutcome(kit, project.id, intent.id);
  await issueStory(kit, project.id, plannedOutcome.id, 0);
  assert.equal((await stateOf(plannedOutcome.id)).state, "incomplete");

  // canceled（有効なTaskが残らない）
  const canceledOutcome = await createOutcome(kit, project.id, intent.id);
  const canceledStory = await issueStory(kit, project.id, canceledOutcome.id);
  ok(await callTool(kit.app, "cancel_task", { taskId: canceledStory.taskIds[0], reason: "Out of scope", requestId: "cancel-1" }, "mgr"));
  assert.equal((await stateOf(canceledOutcome.id)).state, "canceled");

  // 還流はExecutionを変更しない（Task・Storyの状態が変わらない）。
  const tasks = ok(await callTool(kit.app, "list_tasks", { projectId: project.id }, "rt")).tasks as { id: string; status: string }[];
  assert.equal(tasks.find((task) => task.id === rejectedStory.taskIds[0])?.status, "rejected");
  assert.equal(tasks.find((task) => task.id === acceptedStory.taskIds[0])?.status, "accepted");
  await kit.database.destroy();
});

test("同じChange・Evidenceの再送は重複せず、順序逆転した古い通知は状態を巻き戻さず、再起動後も最終状態を復元できる", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-evidence-"));
  const path = join(directory, "compass.db");
  try {
    let kit = await setup(path);
    const { project, intent } = await seedProject(kit);
    const outcome = await createOutcome(kit, project.id, intent.id);
    const { taskIds } = await issueStory(kit, project.id, outcome.id);

    const early = await changesOf(kit.app, project.id);
    const observedAt = Date.now() - 10_000;
    const firstEvidence = evidence({ uri: "https://github.com/example/compass/issues/7", kind: "issue", versionHash: null, observedAt });
    ok(await record(kit.app, project.id, outcome.id, { changeCursor: early.nextCursor, evidence: [firstEvidence] }));

    await advance(kit.app, taskIds[0]!, "accepted");
    const late = await changesOf(kit.app, project.id, early.nextCursor);
    const lateEvidence = evidence({ observedAt });
    const final = ok(await record(kit.app, project.id, outcome.id, { changeCursor: late.nextCursor, evidence: [lateEvidence] }));
    assert.equal(final.summary.state, "accepted");

    // 同じ通知の再送。何も増えず、要約は変わらない。
    const replay = ok(await record(kit.app, project.id, outcome.id, { changeCursor: late.nextCursor, evidence: [lateEvidence] }));
    assert.deepEqual(replay.recorded, { summaryChanged: false, staleInput: false, evidenceAdded: 0 });
    assert.deepEqual(replay.summary, final.summary);
    assert.equal(replay.evidence.length, 2);

    // 順序逆転: 先に取得した古いcursorの通知が後から届いても、最終状態（accepted）を巻き戻さない。
    const stale = ok(await record(kit.app, project.id, outcome.id, { changeCursor: early.nextCursor, evidence: [firstEvidence, lateEvidence] }));
    assert.deepEqual(stale.recorded, { summaryChanged: false, staleInput: true, evidenceAdded: 0 });
    assert.equal(stale.summary.state, "accepted");
    assert.equal(stale.summary.observedCursor, late.nextCursor);
    assert.equal(stale.summary.executionCursor, late.nextCursor);
    assert.equal(stale.evidence.length, 2);

    // 表記だけが違うURL・大文字のSHAは、同じEvidenceとして重複しない。
    const alias = ok(
      await record(kit.app, project.id, outcome.id, {
        changeCursor: late.nextCursor,
        evidence: [{ ...lateEvidence, uri: "HTTPS://GITHUB.COM/example/compass/pull/1", versionHash: sha("a").toUpperCase() }],
      }),
    );
    assert.equal(alias.recorded.evidenceAdded, 0);
    assert.equal(alias.evidence.length, 2);

    // server再起動後も、保存された最終状態・Evidenceが残り、再送しても増えない。
    await kit.database.destroy();
    kit = await setup(path);
    const restored = ok(await callTool(kit.app, "get_outcome_execution_summary", { projectId: project.id, outcomeId: outcome.id }, "rt"));
    assert.deepEqual(restored.record, { summary: final.summary, evidence: final.evidence });
    const afterRestart = ok(await record(kit.app, project.id, outcome.id, { changeCursor: late.nextCursor, evidence: [firstEvidence, lateEvidence] }));
    assert.deepEqual(afterRestart.recorded, { summaryChanged: false, staleInput: false, evidenceAdded: 0 });
    const rows = await kit.database.selectFrom("outcome_execution_evidence").select("id").where("outcome_id", "=", outcome.id).execute();
    assert.equal(rows.length, 2);
    const summaries = await kit.database.selectFrom("outcome_execution_summary").select("outcome_id").execute();
    assert.equal(summaries.length, 1);
    await kit.database.destroy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("同時に届いた同じ通知も1件に収束する", async () => {
  const kit = await setup();
  const { project, intent } = await seedProject(kit);
  const outcome = await createOutcome(kit, project.id, intent.id);
  await issueStory(kit, project.id, outcome.id);
  const head = (await changesOf(kit.app, project.id)).nextCursor;
  const args = { changeCursor: head, evidence: [evidence()] };
  const results = await Promise.all([1, 2, 3].map(() => record(kit.app, project.id, outcome.id, args)));
  for (const result of results) ok(result);
  const rows = await kit.database.selectFrom("outcome_execution_evidence").select("id").execute();
  assert.equal(rows.length, 1);
  assert.equal((await kit.database.selectFrom("outcome_execution_summary").select("outcome_id").execute()).length, 1);
  await kit.database.destroy();
});

test("Projectまたぎ・Outcome対応なし・取消済み・archived・不正なURL / SHA / 時刻 / cursor・Evidence上限を拒否し、何も保存しない", async () => {
  const kit = await setup();
  const { project, intent } = await seedProject(kit);
  const other = await seedProject(kit, "Other");
  const outcome = await createOutcome(kit, project.id, intent.id);
  await issueStory(kit, project.id, outcome.id);
  const head = (await changesOf(kit.app, project.id)).nextCursor;
  const saved = async () => ({
    summaries: (await kit.database.selectFrom("outcome_execution_summary").select("outcome_id").execute()).length,
    evidence: (await kit.database.selectFrom("outcome_execution_evidence").select("id").execute()).length,
  });

  // 認証・認可: Bearerなし、runtime以外、別ProjectのGrantだけ。Outcomeの有無を漏らさない。
  assert.equal(errorOf(await record(kit.app, project.id, outcome.id, { changeCursor: head }, null)).code, "UNAUTHENTICATED");
  assert.equal(errorOf(await record(kit.app, project.id, outcome.id, { changeCursor: head }, "wrk")).code, "FORBIDDEN");
  await grant(kit.app, other.project.id, "rt-other", "runtime");
  assert.equal(errorOf(await record(kit.app, project.id, outcome.id, { changeCursor: head }, "rt-other")).code, "FORBIDDEN");
  assert.equal(errorOf(await record(kit.app, project.id, "missing", { changeCursor: head }, "rt-other")).code, "FORBIDDEN");

  // 別ProjectのOutcome・存在しないOutcomeは同じNOT_FOUND。
  assert.equal(errorOf(await record(kit.app, other.project.id, outcome.id, { changeCursor: 0 })).code, "NOT_FOUND");
  assert.equal(errorOf(await record(kit.app, project.id, "missing", { changeCursor: head })).code, "NOT_FOUND");
  assert.equal(errorOf(await callTool(kit.app, "get_outcome_execution_summary", { projectId: other.project.id, outcomeId: outcome.id }, "rt")).code, "NOT_FOUND");

  // Outcomeに相関付いたStoryが無い（未着手）。存在しないOutcomeとは区別する。
  const unstarted = await createOutcome(kit, project.id, intent.id);
  const noStory = errorOf(await record(kit.app, project.id, unstarted.id, { changeCursor: head }));
  assert.equal(noStory.code, "CONFLICT");
  assert.equal(noStory.reason, "no_correlated_story");

  // 不正な入力: 相対・非http・認証情報付きURL、短縮SHA、commitのSHA欠落、未来の観測時刻、未来のcursor、未知のkind。
  const invalid = async (args: object, path: string) => {
    const error = errorOf(await record(kit.app, project.id, outcome.id, { changeCursor: head, ...args }));
    assert.equal(error.code, "VALIDATION_ERROR", JSON.stringify(error));
    assert.ok((error.issues as { path: string }[]).some((issue) => issue.path === path), `${path}: ${JSON.stringify(error.issues)}`);
  };
  await invalid({ evidence: [evidence({ uri: "/etc/passwd" })] }, "evidence.0.uri");
  await invalid({ evidence: [evidence({ uri: "ftp://example.com/file" })] }, "evidence.0.uri");
  await invalid({ evidence: [evidence({ uri: "https://user:secret@github.com/example/compass" })] }, "evidence.0.uri");
  await invalid({ evidence: [evidence({ versionHash: "abc1234" })] }, "evidence.0.versionHash");
  await invalid({ evidence: [evidence({ versionHash: "z".repeat(40) })] }, "evidence.0.versionHash");
  await invalid({ evidence: [evidence({ kind: "commit", versionHash: null })] }, "evidence.0.versionHash");
  await invalid({ evidence: [evidence({ kind: "blog" })] }, "evidence.0.kind");
  await invalid({ evidence: [evidence({ observedAt: Date.now() + 3_600_000 })] }, "evidence.0.observedAt");
  await invalid({ changeCursor: head + 100 }, "changeCursor");
  await invalid({ changeCursor: -1 }, "changeCursor");
  await invalid({ changeCursor: 1.5 }, "changeCursor");
  assert.deepEqual(await saved(), { summaries: 0, evidence: 0 }, "拒否された入力は何も保存しない");

  // Evidence上限。上限までは保存でき、超える分は部分的に保存せず拒否する。
  const many = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => evidence({ uri: `https://github.com/example/compass/pull/${from + index}`, versionHash: null }));
  for (let batch = 0; batch < 4; batch += 1) ok(await record(kit.app, project.id, outcome.id, { changeCursor: head, evidence: many(batch * 50, 50) }));
  assert.equal((await saved()).evidence, 200);
  const over = errorOf(await record(kit.app, project.id, outcome.id, { changeCursor: head, evidence: many(1_000, 1) }));
  assert.equal(over.code, "CONFLICT");
  assert.equal(over.reason, "evidence_limit_exceeded");
  assert.equal((await saved()).evidence, 200);
  // 既に保存済みの参照の再送は上限に数えない。
  assert.equal(ok(await record(kit.app, project.id, outcome.id, { changeCursor: head, evidence: many(0, 1) })).recorded.evidenceAdded, 0);

  // 取消済みOutcomeとarchived Projectは、新しい還流を受け付けない。
  const cancelled = await createOutcome(kit, project.id, intent.id);
  await issueStory(kit, project.id, cancelled.id);
  await kit.services.cancelOutcomeUseCase.execute(project.id, intent.id, cancelled.id, { reason: "Wrong metric" });
  const cancelledError = errorOf(await record(kit.app, project.id, cancelled.id, { changeCursor: 0 }));
  assert.equal(cancelledError.code, "CONFLICT");
  assert.equal(cancelledError.outcomeStatus, "cancelled");
  await kit.services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  const archived = errorOf(await record(kit.app, project.id, outcome.id, { changeCursor: head }));
  assert.equal(archived.code, "CONFLICT");
  assert.equal(archived.projectStatus, "archived");
  assert.equal((await saved()).evidence, 200);
  await kit.database.destroy();
});

test("Web APIはRuntimeのBearerとruntime Grantを要求し、MCPと同じapplication層の結果・エラーを返す", async () => {
  const kit = await setup();
  const { project, intent } = await seedProject(kit);
  const outcome = await createOutcome(kit, project.id, intent.id);
  await issueStory(kit, project.id, outcome.id);
  const head = (await changesOf(kit.app, project.id)).nextCursor;
  const path = `/api/projects/${project.id}/outcomes/${outcome.id}/execution-evidence`;
  const post = (body: unknown, principal?: string) =>
    kit.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  assert.equal((await post({ changeCursor: head })).status, 401);
  assert.equal((await post({ changeCursor: head }, "wrk")).status, 403);
  assert.equal((await post("not json", "rt")).status, 400);
  assert.equal((await post({ changeCursor: head, evidence: [evidence({ uri: "nope" })] }, "rt")).status, 400);
  assert.equal((await post({ changeCursor: head + 10 }, "rt")).status, 400);

  const response = await post({ changeCursor: head, evidence: [evidence()] }, "rt");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { summary: { state: string }; evidence: unknown[]; recorded: { evidenceAdded: number } };
  assert.equal(body.summary.state, "incomplete");
  assert.equal(body.recorded.evidenceAdded, 1);
  const replay = (await (await post({ changeCursor: head, evidence: [evidence()] }, "rt")).json()) as typeof body;
  assert.equal(replay.recorded.evidenceAdded, 0);
  assert.equal(replay.evidence.length, 1);

  assert.equal((await kit.app.request(`/api/projects/${project.id}/outcomes/missing/execution-summary`)).status, 404);
  assert.equal((await kit.app.request(`/api/projects/missing/outcomes/${outcome.id}/execution-summary`)).status, 404);
  await kit.database.destroy();
});
