import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * Directionが確定したOutcomeを、外部RuntimeがManagerを起動してExecutionのStoryへ引き渡す経路（Task 33）。
 * Runtimeとして振る舞うのはtest内のMCP呼び出しだけで、Agentの自動起動・polling・実Runtimeは未接続。
 * Lv6の自律運転の実証ではない。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Kit = Awaited<ReturnType<typeof setup>>;

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services) };
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

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; message: string } & Record<string, any>;
};

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const grant = async (app: App, projectId: string, principalId: string, role: string) =>
  assert.equal((await send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role })).status, 201);

const successCriteria = [
  { description: "duplicate_claim_count = 0", measurement: "Count duplicate claims", target: "= 0" },
  { description: "Every claim is audited", measurement: "Change log entry exists" },
];

/** ProjectにManager・Strategist・Runtime・Workerを割り当て、Strategistの判断でOutcome（origin Decision付き）を確定させる。 */
const confirmOutcome = async ({ services, app }: Kit) => {
  const project = await services.createProjectUseCase.execute({
    name: "Compass",
    mission: "Keep execution guarded",
    constraints: ["No autonomous execution yet", "Keep the public API"],
    repositories: [{ name: "compass", url: "https://github.com/example/compass" }],
  });
  const intent = await services.createIntentUseCase.execute(project.id, { title: "Exclusive claims", desiredState: "One owner per Task" });
  for (const [principal, role] of [["strat", "strategist"], ["mgr", "manager"], ["wrk", "worker"], ["rt", "runtime"]] as const) {
    await grant(app, project.id, principal, role);
  }
  const decided = await callTool(
    app,
    "decide_next_outcome",
    {
      projectId: project.id,
      intentId: intent.id,
      judgment: "Claims must be exclusive",
      reason: "Duplicate claims cause rework",
      requestKey: "decide-1",
      runRef: "run-1",
      outcome: { title: "No duplicate claims", description: "Claims are exclusive.", rationale: "Rework", successCriteria },
    },
    "strat",
  );
  assert.equal(decided.isError, undefined, JSON.stringify(decided.structuredContent));
  const { decision, outcome } = decided.structuredContent as { decision: { id: string }; outcome: { id: string; originDecisionId: string; successCriteria: { id: string }[] } };
  assert.equal(outcome.originDecisionId, decision.id);
  return { project, intent, outcome, decisionId: decision.id };
};

const storiesOf = async (app: App, projectId: string) =>
  (await callTool(app, "list_stories", { projectId }, "mgr")).structuredContent.stories as Record<string, any>[];

test("Outcome確定でRuntimeがoutcome_confirmedを取得でき、Managerがissue_storyで固定Success Criteria・Constraints・Repository・相関ID付きのStoryを作れる", async () => {
  const kit = await setup();
  const { project, intent, outcome, decisionId } = await confirmOutcome(kit);

  // Runtime: 確定イベントを取得してManagerを起動する（起動はtest内の呼び出し）。
  const fetched = await callTool(kit.app, "fetch_runtime_events", { projectId: project.id }, "rt");
  const event = (fetched.structuredContent.events as Record<string, any>[]).find((item) => item.type === "outcome_confirmed")!;
  assert.equal(event.outcomeId, outcome.id);
  assert.equal(event.intentId, intent.id);
  assert.equal(event.researchRequestId, null);
  assert.equal(event.correlationId, `outcome:${outcome.id}`);

  // Manager: Outcomeを読み、Storyへ引き渡す。Compassはここまで何も作らない。
  assert.deepEqual(await storiesOf(kit.app, project.id), []);
  const repositoryId = (await kit.services.getProjectUseCase.execute(project.id)).repositories[0]!.id;
  const issued = await callTool(
    kit.app,
    "issue_story",
    { projectId: project.id, title: "Exclusive claims", description: "Implement guarded claims", outcomeId: event.outcomeId, repositoryId, requestId: "handoff-1" },
    "mgr",
  );
  assert.equal(issued.isError, undefined, JSON.stringify(issued.structuredContent));
  const story = issued.structuredContent;
  assert.equal(story.outcomeId, outcome.id);
  assert.equal(story.originDecisionId, decisionId);
  assert.equal(story.correlationId, `outcome:${outcome.id}`);
  assert.deepEqual(story.constraints, ["No autonomous execution yet", "Keep the public API"]);
  assert.deepEqual(story.repository, { id: repositoryId, name: "compass", url: "https://github.com/example/compass" });
  // 固定されたSuccess Criteriaが、ID付きでそのまま入る（Task 35のEvaluatorが基準として辿れる）。
  assert.deepEqual(
    story.successCriteria.map(({ id, position, description, measurement, target }: Record<string, unknown>) => ({ id, position, description, measurement, target })),
    outcome.successCriteria.map((criterion, index) => ({ id: criterion.id, position: index, description: successCriteria[index]!.description, measurement: successCriteria[index]!.measurement, target: successCriteria[index]!.target ?? null })),
  );

  // ManagerがStory配下にTaskを作ると、Change Logから相関ID・Outcomeを辿れる。
  const task = await callTool(kit.app, "issue_task", { projectId: project.id, storyId: story.id, title: "Guard claims", requestId: "handoff-task-1" }, "mgr");
  assert.equal(task.isError, undefined);
  const changes = (await callTool(kit.app, "list_changes", { projectId: project.id }, "rt")).structuredContent.changes as Record<string, any>[];
  assert.deepEqual(changes.map((change) => change.type), ["STORY_CREATED", "TASK_CREATED"]);
  assert.deepEqual(changes[0]!.payload, { actorRole: "manager", status: "todo", correlationId: `outcome:${outcome.id}`, outcomeId: outcome.id, originDecisionId: decisionId });
  assert.equal(changes[1]!.payload.correlationId, `outcome:${outcome.id}`);
  assert.equal(changes[1]!.payload.outcomeId, outcome.id);
  await kit.database.destroy();
});

test("同じhandoffの再送は、同じrequestIdでも新しいrequestId（timeout後の再起動）でも同じStoryを返し、二重に作らない", async () => {
  const kit = await setup();
  const { project, outcome } = await confirmOutcome(kit);
  const args = { projectId: project.id, title: "Story", outcomeId: outcome.id };

  const first = (await callTool(kit.app, "issue_story", { ...args, requestId: "req-1" }, "mgr")).structuredContent;
  const sameRequest = (await callTool(kit.app, "issue_story", { ...args, requestId: "req-1" }, "mgr")).structuredContent;
  const newRequest = (await callTool(kit.app, "issue_story", { ...args, requestId: "req-2" }, "mgr")).structuredContent;
  assert.equal(sameRequest.id, first.id);
  assert.equal(newRequest.id, first.id);
  assert.deepEqual(newRequest, first);
  assert.equal((await storiesOf(kit.app, project.id)).length, 1);
  const created = (await callTool(kit.app, "list_changes", { projectId: project.id }, "rt")).structuredContent.changes.filter((change: { type: string }) => change.type === "STORY_CREATED");
  assert.equal(created.length, 1);

  // 同じ相関IDに別の内容は衝突。requestIdを別の内容に使い回しても衝突。
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, title: "Another", requestId: "req-3" }, "mgr")).code, "IDEMPOTENCY_CONFLICT");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, title: "Another", requestId: "req-1" }, "mgr")).code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await storiesOf(kit.app, project.id)).length, 1);

  // 同時に届いた重複handoffも1件に収束する。
  const other = await confirmOutcomeAgain(kit, project.id);
  const [left, right] = await Promise.all([
    callTool(kit.app, "issue_story", { projectId: project.id, title: "Concurrent", outcomeId: other, requestId: "race-a" }, "mgr"),
    callTool(kit.app, "issue_story", { projectId: project.id, title: "Concurrent", outcomeId: other, requestId: "race-b" }, "mgr"),
  ]);
  assert.equal(left.isError, undefined);
  assert.equal(right.isError, undefined);
  assert.equal(left.structuredContent.id, right.structuredContent.id);
  assert.equal((await storiesOf(kit.app, project.id)).length, 2);
  await kit.database.destroy();
});

/** 同じProjectに2件目のOutcome（別のIntentは作れないため、既存Intent配下）を作る。 */
const confirmOutcomeAgain = async (kit: Kit, projectId: string): Promise<string> => {
  const intent = (await kit.services.listIntentsUseCase.execute(projectId))[0]!;
  const created = await kit.services.createOutcomeUseCase.execute(projectId, intent.id, {
    title: "Second",
    description: "d",
    rationale: "r",
    successCriteria: [{ description: "d", measurement: "m" }],
  });
  return created.id;
};

test("StoryのsnapshotはOutcome・Constraintsが後で変わっても変わらず、Outcome取消後も同じhandoffの再送は元のStoryを返す", async () => {
  const kit = await setup();
  const { project, intent, outcome } = await confirmOutcome(kit);
  const args = { projectId: project.id, title: "Story", outcomeId: outcome.id };
  const story = (await callTool(kit.app, "issue_story", { ...args, requestId: "req-1" }, "mgr")).structuredContent;

  await kit.services.updateProjectUseCase.execute(project.id, { constraints: ["Changed later"] });
  await kit.services.cancelOutcomeUseCase.execute(project.id, intent.id, outcome.id, { reason: "Wrong metric" });

  const listed = (await storiesOf(kit.app, project.id))[0]!;
  assert.deepEqual(listed.constraints, ["No autonomous execution yet", "Keep the public API"]);
  assert.deepEqual(listed.successCriteria, story.successCriteria);
  const replay = await callTool(kit.app, "issue_story", { ...args, requestId: "req-late" }, "mgr");
  assert.equal(replay.isError, undefined, "取消後の再送で、作成済みのStoryは失われない");
  assert.equal(replay.structuredContent.id, story.id);

  // 取消済みOutcomeからは新しいStoryを作らない（別の相関IDでも）。
  const fresh = errorOf(await callTool(kit.app, "issue_story", { ...args, correlationId: "outcome:again", requestId: "req-new" }, "mgr"));
  assert.equal(fresh.code, "CONFLICT");
  assert.equal(fresh.status, "cancelled");
  assert.equal((await storiesOf(kit.app, project.id)).length, 1);
  await kit.database.destroy();
});

test("Project対応なし・認証失敗・入力不正・権限不足を区別し、どの失敗でもStoryを部分的に残さない", async () => {
  const kit = await setup();
  const { project, outcome } = await confirmOutcome(kit);
  const other = await kit.services.createProjectUseCase.execute({ name: "Other", mission: "m" });
  await grant(kit.app, other.id, "mgr", "manager");
  const args = { projectId: project.id, title: "Story", outcomeId: outcome.id };

  // 認証失敗（Bearerなし）はUNAUTHENTICATED。
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, requestId: "r1" })).code, "UNAUTHENTICATED");
  // manager以外は、Outcomeの有無に関わらずFORBIDDEN。存在しないOutcomeも同じで、存在有無を漏らさない。
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, requestId: "r2" }, "wrk")).code, "FORBIDDEN");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, outcomeId: "missing", requestId: "r3" }, "wrk")).code, "FORBIDDEN");
  // Grantの無いProjectも、存在しないProjectも同じFORBIDDEN。
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, projectId: "missing", requestId: "r4" }, "mgr")).code, "FORBIDDEN");
  // 別ProjectのOutcome・存在しないOutcome・存在しないRepositoryはNOT_FOUND。
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { projectId: other.id, title: "S", outcomeId: outcome.id, requestId: "r5" }, "mgr")).code, "NOT_FOUND");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, outcomeId: "missing", requestId: "r6" }, "mgr")).code, "NOT_FOUND");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, repositoryId: "missing", requestId: "r7" }, "mgr")).code, "NOT_FOUND");
  // 入力不正（空白のid・title・長すぎる相関ID）はINVALID_INPUT。
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, outcomeId: "  ", requestId: "r8" }, "mgr")).code, "INVALID_INPUT");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, title: "   ", requestId: "r9" }, "mgr")).code, "INVALID_INPUT");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { ...args, correlationId: "x".repeat(201), requestId: "r10" }, "mgr")).code, "INVALID_INPUT");

  assert.deepEqual(await storiesOf(kit.app, project.id), []);
  assert.deepEqual(await storiesOf(kit.app, other.id).catch(() => []), []);
  assert.equal((await kit.database.selectFrom("story").select("id").execute()).length, 0);
  assert.equal((await kit.database.selectFrom("change_log").select("cursor").execute()).length, 0);

  // 失敗後も、正しい入力で同じOutcomeからStoryを作れる（回復可能）。
  assert.equal((await callTool(kit.app, "issue_story", { ...args, requestId: "ok" }, "mgr")).isError, undefined);
  await kit.database.destroy();
});

test("archivedのProjectではStory・Taskを起票できず、work Claimも取れない。既存のStory・Taskは参照できる", async () => {
  const kit = await setup();
  const { project, outcome } = await confirmOutcome(kit);
  const story = (await callTool(kit.app, "issue_story", { projectId: project.id, title: "Story", outcomeId: outcome.id, requestId: "s1" }, "mgr")).structuredContent;
  const task = (await callTool(kit.app, "issue_task", { projectId: project.id, storyId: story.id, title: "Task", requestId: "t1" }, "mgr")).structuredContent;

  await kit.services.archiveProjectUseCase.execute(project.id, { reason: "Done" });

  for (const [name, args, principal] of [
    ["issue_story", { projectId: project.id, title: "New", requestId: "s2" }, "mgr"],
    ["issue_task", { projectId: project.id, title: "New", requestId: "t2" }, "mgr"],
    ["claim_task", { taskId: task.id, requestId: "c1" }, "wrk"],
  ] as const) {
    const error = errorOf(await callTool(kit.app, name, args, principal));
    assert.equal(error.code, "CONFLICT", name);
    assert.equal(error.projectStatus, "archived", name);
  }
  assert.equal((await storiesOf(kit.app, project.id)).length, 1);
  assert.equal((await callTool(kit.app, "list_tasks", { projectId: project.id }, "wrk")).structuredContent.tasks.length, 1);
  await kit.database.destroy();
});

test("Execution層はOutcome・Success Criteriaを変更できず、Direction toolはStory・Taskを変更しない", async () => {
  const kit = await setup();
  const { project, intent, outcome } = await confirmOutcome(kit);
  const before = await kit.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id);

  const story = (await callTool(kit.app, "issue_story", { projectId: project.id, title: "Story", outcomeId: outcome.id, requestId: "s1" }, "mgr")).structuredContent;
  const task = (await callTool(kit.app, "issue_task", { projectId: project.id, storyId: story.id, title: "Task", requestId: "t1" }, "mgr")).structuredContent;
  const work = (await callTool(kit.app, "claim_task", { taskId: task.id, requestId: "c1" }, "wrk")).structuredContent;
  await callTool(kit.app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "done", requestId: "c2" }, "wrk");
  await callTool(kit.app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: "c3" }, "wrk");
  await callTool(kit.app, "cancel_story", { storyId: story.id, reason: "Superseded", requestId: "c4" }, "mgr");

  // Execution Roleには、Outcomeを作る・変える・取消すtoolを通せない。
  for (const [name, args] of [
    ["update_outcome", { projectId: project.id, intentId: intent.id, outcomeId: outcome.id, title: "Hacked" }],
    ["cancel_outcome", { projectId: project.id, intentId: intent.id, outcomeId: outcome.id, reason: "x" }],
    ["create_outcome", { projectId: project.id, intentId: intent.id, title: "T", description: "d", rationale: "r", successCriteria: [{ description: "d", measurement: "m" }] }],
  ] as const) {
    for (const principal of ["mgr", "wrk"]) assert.equal(errorOf(await callTool(kit.app, name, args, principal)).code, "FORBIDDEN", `${name}/${principal}`);
  }
  assert.deepEqual(await kit.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id), before);

  // Strategist（Direction）はExecutionのStory・Taskを変更するtoolを持たず、Executionの操作もできない。
  assert.equal(errorOf(await callTool(kit.app, "cancel_task", { taskId: task.id, reason: "x", requestId: "d1" }, "strat")).code, "FORBIDDEN");
  assert.equal(errorOf(await callTool(kit.app, "issue_story", { projectId: project.id, title: "S", requestId: "d2" }, "strat")).code, "FORBIDDEN");
  assert.equal(errorOf(await callTool(kit.app, "claim_task", { taskId: task.id, requestId: "d3" }, "strat")).code, "FORBIDDEN");
  await kit.database.destroy();
});

test("handoff済みのStory・Changeはserver再起動後も残り、再起動後の再送でも二重に作られない", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-handoff-"));
  const path = join(directory, "compass.db");
  try {
    const first = await setup(path);
    const { project, outcome } = await confirmOutcome(first);
    const created = (await callTool(first.app, "issue_story", { projectId: project.id, title: "Story", outcomeId: outcome.id, requestId: "req-1" }, "mgr")).structuredContent;
    await first.database.destroy();

    const second = await setup(path);
    assert.deepEqual((await storiesOf(second.app, project.id)).map((story) => story.id), [created.id]);
    const replay = (await callTool(second.app, "issue_story", { projectId: project.id, title: "Story", outcomeId: outcome.id, requestId: "req-after-restart" }, "mgr")).structuredContent;
    assert.equal(replay.id, created.id);
    assert.equal((await storiesOf(second.app, project.id)).length, 1);
    const events = (await callTool(second.app, "fetch_runtime_events", { projectId: project.id }, "rt")).structuredContent.events as { type: string }[];
    assert.equal(events.filter((event) => event.type === "outcome_confirmed").length, 1);
    await second.database.destroy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Outcomeを介さない手動起票のStoryは従来どおり作れ、snapshotは持たない", async () => {
  const kit = await setup();
  const { project } = await confirmOutcome(kit);
  const manual = (await callTool(kit.app, "issue_story", { projectId: project.id, title: "Maintenance", requestId: "m1" }, "mgr")).structuredContent;
  assert.deepEqual(
    [manual.outcomeId, manual.originDecisionId, manual.successCriteria, manual.constraints, manual.repository, manual.correlationId],
    [null, null, null, null, null, null],
  );
  // 相関IDを持たないStoryは、同じ入力でも別のStoryになる（旧Wachaと同じ）。requestIdの再送だけが冪等。
  const again = (await callTool(kit.app, "issue_story", { projectId: project.id, title: "Maintenance", requestId: "m2" }, "mgr")).structuredContent;
  assert.notEqual(again.id, manual.id);
  const replay = (await callTool(kit.app, "issue_story", { projectId: project.id, title: "Maintenance", requestId: "m1" }, "mgr")).structuredContent;
  assert.equal(replay.id, manual.id);
  await kit.database.destroy();
});
