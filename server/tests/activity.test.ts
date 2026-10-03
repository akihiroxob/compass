import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import type { createApp } from "../src/bootstrap/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

/**
 * Activity（docs/architecture-migration-mapping.md Task 07）。MCPでの記録・参照の認可、必須summary・refs・runIdの拒否、
 * requestIdの冪等性、訂正の追記、Work・Directionの状態変更からのcanonical生成（同一transaction・重複なし）、Role Context・Web APIへの接続を確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, app: await createSignedInApp(database, createApplicationServices(database)) };
};

let rpcId = 0;
const callTool = async (app: App, name: string, args: object, principal?: string, activeRole?: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error.code as string;
};

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type ProjectBody = { id: string; repositories: { id: string }[]; resources: { id: string }[] };

const createProject = async (app: App, name = "Compass") =>
  (
    (await (
      await send(app, "POST", "/api/projects", {
        name,
        mission: "Keep execution guarded",
        repositories: [{ name: "primary", url: "https://example.com/compass.git" }],
        resources: [{ name: "design", url: "https://example.com/docs", kind: "docs" }],
      })
    ).json()) as { project: ProjectBody }
  ).project;

const grant = (app: App, projectId: string, principalId: string, role: string) =>
  send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });

const record = (app: App, principal: string | undefined, input: object, activeRole?: string) =>
  callTool(app, "record_activity", input, principal, activeRole);

test("Agentはsummary必須・本文任意・成果物参照付きのActivityを記録し、一覧はsummaryとrefsだけ、本文はget_activityで取得する", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "researcher-a", "researcher");
  await grant(app, project.id, "worker-a", "worker");

  const recorded = ok(
    await record(app, "researcher-a", {
      projectId: project.id,
      type: "research.summary",
      role: "researcher",
      summary: "  認証方式の調査を完了。OAuthを第一候補とした  ",
      body: "## 比較\n- OAuth\n- SAML",
      refs: [
        { kind: "project_resource", resourceId: project.repositories[0]!.id, path: "docs/research/auth.md", revision: "abc123" },
        { kind: "url", url: "https://example.com/rfc" },
        { kind: "intent", id: "intent-1" },
      ],
      occurredAt: 1_700_000_000_000,
      requestId: "r-1",
    }),
  );
  assert.equal(recorded.created, true);
  const activity = recorded.activity;
  assert.equal(activity.scope, "project");
  assert.equal(activity.projectId, project.id);
  assert.equal(activity.principalId, "researcher-a");
  assert.equal(activity.role, "researcher");
  assert.equal(activity.summary, "認証方式の調査を完了。OAuthを第一候補とした");
  assert.equal(activity.source, "recorded");
  assert.equal(activity.occurredAt, 1_700_000_000_000);
  assert.deepEqual(activity.refs[0], {
    kind: "project_resource",
    resourceId: project.repositories[0]!.id,
    path: "docs/research/auth.md",
    revision: "abc123",
  });
  assert.equal("runId" in activity, false, "実行単位は持たない");

  // 別Roleで記録したActivityも、ProjectのいずれかのGrantがあれば読める。
  const page = ok(await callTool(app, "list_activities", { projectId: project.id }, "worker-a"));
  assert.equal(page.activities.length, 1);
  assert.equal(page.activities[0].hasBody, true);
  assert.equal("body" in page.activities[0], false, "一覧に本文は含めない");
  assert.equal(page.nextCursor, null);

  const detail = ok(await callTool(app, "get_activity", { projectId: project.id, activityId: activity.id }, "worker-a"));
  assert.equal(detail.activity.body, "## 比較\n- OAuth\n- SAML");
  assert.deepEqual(detail.corrections, []);

  // refの対象で絞り込める。
  const byRef = ok(
    await callTool(app, "list_activities", { projectId: project.id, refKind: "project_resource", refId: project.repositories[0]!.id }, "worker-a"),
  );
  assert.deepEqual(byRef.activities.map((item: { id: string }) => item.id), [activity.id]);
  const none = ok(await callTool(app, "list_activities", { projectId: project.id, refKind: "task", refId: "intent-1" }, "worker-a"));
  assert.deepEqual(none.activities, []);
  await database.destroy();
});

test("記録・参照はProject Grantで認可し、RoleはGrantを持つRoleかactiveRoleに限る", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  const other = await createProject(app, "Other");
  await grant(app, project.id, "worker-a", "worker");
  await grant(app, other.id, "outsider", "worker");
  const input = { projectId: project.id, type: "handoff.note", summary: "引き継ぎ", requestId: "r-1" };

  assert.equal(errorCode(await record(app, undefined, { ...input, role: "worker" })), "UNAUTHENTICATED");
  assert.equal(errorCode(await record(app, "outsider", { ...input, role: "worker" })), "FORBIDDEN");
  // 持っていないRoleを名乗れない。
  assert.equal(errorCode(await record(app, "worker-a", { ...input, role: "reviewer" })), "FORBIDDEN");
  // activeRoleが無ければRoleを決められない。
  assert.equal(errorCode(await record(app, "worker-a", input)), "VALIDATION_ERROR");
  // activeRoleと異なるRoleは名乗れない。
  assert.equal(errorCode(await record(app, "worker-a", { ...input, role: "manager" }, "worker")), "FORBIDDEN");
  // activeRoleの指定時はそのRoleで記録する。
  const recorded = ok(await record(app, "worker-a", input, "worker"));
  assert.equal(recorded.activity.role, "worker");

  assert.equal(errorCode(await callTool(app, "list_activities", { projectId: project.id }, "outsider")), "FORBIDDEN");
  assert.equal(errorCode(await callTool(app, "list_activities", { projectId: project.id })), "UNAUTHENTICATED");
  assert.equal(
    errorCode(await callTool(app, "get_activity", { projectId: project.id, activityId: recorded.activity.id }, "outsider")),
    "FORBIDDEN",
  );
  // 別ProjectのIDでは取得できない。
  assert.equal(
    errorCode(await callTool(app, "get_activity", { projectId: other.id, activityId: recorded.activity.id }, "outsider")),
    "NOT_FOUND",
  );
  await database.destroy();
});

test("summary必須・runIdの拒否・未登録Resource・不正なrefを検証する", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "worker-a", "worker");
  const base = { projectId: project.id, type: "handoff.note", summary: "引き継ぎ", role: "worker" };

  assert.equal(errorCode(await record(app, "worker-a", { ...base, summary: "   ", requestId: "a" })), "VALIDATION_ERROR");
  assert.equal(errorCode(await record(app, "worker-a", { ...base, runId: "run-1", requestId: "b" })), "VALIDATION_ERROR");
  // MCP境界で未知のtop-level項目を黙って捨てない（成果物本文の誤送信に呼出元が気づける）。
  const unknownField = await record(app, "worker-a", { ...base, artifactContent: "# 成果物の本文", requestId: "b2" });
  assert.equal(errorCode(unknownField), "VALIDATION_ERROR");
  assert.match(JSON.stringify(unknownField.structuredContent), /artifactContent/);
  assert.equal(errorCode(await record(app, "worker-a", { ...base, type: "Not A Type", requestId: "c" })), "VALIDATION_ERROR");
  assert.equal(
    errorCode(await record(app, "worker-a", { ...base, refs: [{ kind: "project_resource", resourceId: "missing" }], requestId: "d" })),
    "VALIDATION_ERROR",
  );
  assert.equal(
    errorCode(await record(app, "worker-a", { ...base, refs: [{ kind: "url", url: "javascript:alert(1)" }], requestId: "e" })),
    "VALIDATION_ERROR",
  );
  // 成果物の本文をrefへ持たせない（未知の項目は拒否）。
  assert.equal(
    errorCode(await record(app, "worker-a", { ...base, refs: [{ kind: "url", url: "https://example.com", content: "..." }], requestId: "f" })),
    "VALIDATION_ERROR",
  );
  const listed = ok(await callTool(app, "list_activities", { projectId: project.id }, "worker-a"));
  assert.deepEqual(listed.activities, [], "拒否した記録は残らない");
  await database.destroy();
});

test("同じrequestIdの再送は同じActivityを返し、別内容の再利用はCONFLICT。訂正は元を書き換えずに追記する", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "worker-a", "worker");
  await grant(app, project.id, "worker-b", "worker");
  const input = { projectId: project.id, type: "decision.recorded", summary: "SQLiteを維持する", role: "worker", requestId: "r-1" };

  const first = ok(await record(app, "worker-a", input));
  const [resent, concurrent] = await Promise.all([record(app, "worker-a", input), record(app, "worker-a", input)]);
  for (const result of [resent, concurrent]) {
    assert.equal(ok(result).activity.id, first.activity.id);
    assert.equal(ok(result).created, false);
  }
  assert.equal(errorCode(await record(app, "worker-a", { ...input, summary: "PostgreSQLへ移す" })), "CONFLICT");
  // requestIdはPrincipalごと。
  const other = ok(await record(app, "worker-b", input));
  assert.notEqual(other.activity.id, first.activity.id);

  const correction = ok(
    await record(app, "worker-a", {
      ...input,
      summary: "SQLiteを維持する（期限は次のOutcomeまで）",
      correctsActivityId: first.activity.id,
      requestId: "r-2",
    }),
  );
  assert.equal(correction.activity.correctsActivityId, first.activity.id);
  const original = ok(await callTool(app, "get_activity", { projectId: project.id, activityId: first.activity.id }, "worker-a"));
  assert.equal(original.activity.summary, "SQLiteを維持する", "元のActivityは書き換えない");
  assert.deepEqual(original.corrections.map((item: { id: string }) => item.id), [correction.activity.id]);
  assert.equal(
    errorCode(await record(app, "worker-a", { ...input, correctsActivityId: "missing", requestId: "r-3" })),
    "NOT_FOUND",
  );

  const listed = ok(await callTool(app, "list_activities", { projectId: project.id }, "worker-a"));
  assert.equal(listed.activities.length, 3);
  await database.destroy();
});

test("成功済みrequestIdの再送は、参照Resourceが外れた後も同じActivityを返す", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "worker-a", "worker");
  const input = {
    projectId: project.id,
    type: "deliverable.published",
    summary: "設計文書を更新した",
    refs: [{ kind: "project_resource", resourceId: project.resources[0]!.id, path: "design.md" }],
    role: "worker",
    requestId: "r-1",
  };
  const first = ok(await record(app, "worker-a", input));
  assert.equal((await send(app, "PATCH", `/api/projects/${project.id}`, { resources: [] })).status, 200);
  // 新しい記録としては未登録Resourceで拒否されるが、成功済みの再送は照合だけで返す。
  assert.equal(errorCode(await record(app, "worker-a", { ...input, requestId: "r-2" })), "VALIDATION_ERROR");
  const replayed = ok(await record(app, "worker-a", input));
  assert.equal(replayed.created, false);
  assert.equal(replayed.activity.id, first.activity.id);
  // 照合の前にGrantは検証する。
  assert.equal(errorCode(await record(app, "outsider", input)), "FORBIDDEN");
  await database.destroy();
});

test("cursorで差分・古い順のページを取得でき、archivedのProjectでは記録できない", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "worker-a", "worker");
  for (const index of [1, 2, 3]) {
    ok(await record(app, "worker-a", { projectId: project.id, type: "note", summary: `note ${index}`, role: "worker", requestId: `r-${index}` }));
  }
  const newest = ok(await callTool(app, "list_activities", { projectId: project.id, limit: 2 }, "worker-a"));
  assert.deepEqual(newest.activities.map((item: { summary: string }) => item.summary), ["note 3", "note 2"]);
  const older = ok(await callTool(app, "list_activities", { projectId: project.id, limit: 2, beforeCursor: newest.nextCursor }, "worker-a"));
  assert.deepEqual(older.activities.map((item: { summary: string }) => item.summary), ["note 1"]);
  assert.equal(older.nextCursor, null);

  const firstCursor = older.activities[0].cursor as number;
  const diff = ok(await callTool(app, "list_activities", { projectId: project.id, afterCursor: firstCursor }, "worker-a"));
  assert.deepEqual(diff.activities.map((item: { summary: string }) => item.summary), ["note 2", "note 3"]);
  const caughtUp = ok(await callTool(app, "list_activities", { projectId: project.id, afterCursor: diff.nextCursor }, "worker-a"));
  assert.deepEqual(caughtUp, { activities: [], nextCursor: diff.nextCursor });
  assert.equal(
    errorCode(await callTool(app, "list_activities", { projectId: project.id, afterCursor: 0, beforeCursor: 5 }, "worker-a")),
    "VALIDATION_ERROR",
  );

  const archived = await send(app, "POST", `/api/projects/${project.id}/archive`, { reason: "done" });
  assert.equal(archived.status, 200);
  assert.equal(
    errorCode(await record(app, "worker-a", { projectId: project.id, type: "note", summary: "late", role: "worker", requestId: "r-9" })),
    "CONFLICT",
  );
  // 成功済みrequestIdの再送（通信断後等）は、archive後も同じActivityを返す。別内容ならCONFLICT。
  const firstInput = { projectId: project.id, type: "note", summary: "note 1", role: "worker", requestId: "r-1" };
  const replayed = ok(await record(app, "worker-a", firstInput));
  assert.equal(replayed.created, false);
  assert.equal(replayed.activity.id, older.activities[0].id);
  assert.equal(errorCode(await record(app, "worker-a", { ...firstInput, summary: "changed" })), "CONFLICT");
  // archived後も履歴は読める。archive自体はcanonical Activityとして残る。
  const afterArchive = ok(await callTool(app, "list_activities", { projectId: project.id }, "worker-a"));
  assert.deepEqual(
    afterArchive.activities.map((item: { type: string }) => item.type),
    ["project.archived", "note", "note", "note"],
  );
  await database.destroy();
});

test("Workの重要な状態変更は同じtransactionでcanonical Activityになり、再送・Claim操作では増えない", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "manager-a", "manager");
  await grant(app, project.id, "worker-a", "worker");

  const story = ok(await callTool(app, "issue_story", { projectId: project.id, title: "Activityを作る", requestId: "s-1" }, "manager-a"));
  const task = ok(
    await callTool(app, "issue_task", { projectId: project.id, storyId: story.id, title: "保存する", requestId: "t-1" }, "manager-a"),
  );
  const claim = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: "c-1" }, "worker-a"));
  // コメントなしのcomplete_taskは失敗し、Activityも残らない。
  assert.equal(errorCode(await callTool(app, "complete_task", { taskId: task.id, claimId: claim.claimId, requestId: "x-0" }, "worker-a")), "INVALID_TASK_STATUS");
  ok(await callTool(app, "add_task_comment", { taskId: task.id, claimId: claim.claimId, body: "done", requestId: "m-1" }, "worker-a"));
  const completeInput = { taskId: task.id, claimId: claim.claimId, requestId: "x-1" };
  ok(await callTool(app, "complete_task", completeInput, "worker-a"));
  ok(await callTool(app, "complete_task", completeInput, "worker-a"));

  const page = ok(await callTool(app, "list_activities", { projectId: project.id, afterCursor: 0 }, "worker-a"));
  assert.deepEqual(
    page.activities.map((item: any) => [item.type, item.principalId, item.role, item.source]),
    [
      ["story.created", "manager-a", "manager", "canonical"],
      ["task.created", "manager-a", "manager", "canonical"],
      ["task.completed", "worker-a", "worker", "canonical"],
    ],
  );
  const completed = page.activities[2];
  assert.equal(completed.summary, "Task「保存する」の作業を完了し、レビューへ進めた");
  assert.deepEqual(completed.refs, [{ kind: "task", id: task.id }, { kind: "story", id: story.id }]);
  // Change Logとは別で、Change Logはcanonical化しないClaim操作も含めて従来どおり残る。
  const changes = ok(await callTool(app, "list_changes", { projectId: project.id }, "worker-a"));
  assert.ok(changes.changes.some((change: { type: string }) => change.type === "TASK_CLAIMED"));
  assert.equal(changes.changes.length > page.activities.length, true);

  // Activityを保存できなければ状態変更も確定しない（同一transaction）。
  await sql`drop table activity`.execute(database);
  const failed = await callTool(app, "issue_task", { projectId: project.id, storyId: story.id, title: "残らない", requestId: "t-2" }, "manager-a");
  assert.equal(failed.isError, true);
  const tasks = (await sql<{ title: string }>`select title from task where project_id = ${project.id}`.execute(database)).rows;
  assert.deepEqual(tasks.map(({ title }) => title), ["保存する"]);
  await database.destroy();
});

test("Directionの重要な状態変更は同じtransactionで操作者付きのcanonical Activityになり、再送・文言編集では増えない", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "strategist-a", "strategist");
  await grant(app, project.id, "worker-a", "worker");

  // Human（Web UI）の操作は認証済みHumanをoperatorとして記録する。
  const intentResponse = await send(app, "POST", `/api/projects/${project.id}/intents`, { title: "認証を整える", desiredState: "Humanがsign inできる" });
  assert.equal(intentResponse.status, 201);
  const intent = ((await intentResponse.json()) as { intent: { id: string } }).intent;
  assert.equal((await send(app, "PATCH", `/api/projects/${project.id}/intents/${intent.id}`, { title: "認証を整備する" })).status, 200);

  // Agent（MCP）の操作は認可したPrincipalとRoleで記録する。requestKeyの再送では増えない。
  const decideInput = {
    projectId: project.id,
    intentId: intent.id,
    judgment: "OIDCから着手する",
    reason: "既存IdPを使える",
    requestKey: "decide-1",
    runRef: "run-1",
    outcome: { title: "OIDCでsign inできる", description: "D", rationale: "R", successCriteria: [{ description: "d", measurement: "m" }] },
  };
  const decided = ok(await callTool(app, "decide_next_outcome", decideInput, "strategist-a"));
  ok(await callTool(app, "decide_next_outcome", decideInput, "strategist-a"));
  ok(
    await callTool(
      app,
      "cancel_outcome",
      { projectId: project.id, intentId: intent.id, outcomeId: decided.outcome.id, reason: "範囲を見直す" },
      "strategist-a",
    ),
  );

  assert.equal((await send(app, "POST", `/api/projects/${project.id}/intents/${intent.id}/abandon`, { reason: "方針を変える" })).status, 200);

  const page = ok(await callTool(app, "list_activities", { projectId: project.id, afterCursor: 0 }, "worker-a"));
  const facts = page.activities.map((item: any) => [item.type, item.principalId.startsWith("human:") ? "human" : item.principalId, item.role, item.source]);
  assert.deepEqual(facts, [
    ["intent.created", "human", "operator", "canonical"],
    ["outcome.confirmed", "strategist-a", "strategist", "canonical"],
    ["decision.recorded", "strategist-a", "strategist", "canonical"],
    ["outcome.canceled", "strategist-a", "strategist", "canonical"],
    ["intent.abandoned", "human", "operator", "canonical"],
  ]);
  const [created, confirmed, recorded, canceled, abandoned] = page.activities;
  assert.equal(created.summary, "Intent「認証を整える」を作成した");
  assert.deepEqual(created.refs, [{ kind: "intent", id: intent.id }]);
  assert.deepEqual(
    confirmed.refs,
    [
      { kind: "outcome", id: decided.outcome.id },
      { kind: "intent", id: intent.id },
      { kind: "decision", id: decided.decision.id },
    ],
  );
  assert.equal(recorded.summary, "Direction Decision（next_outcome）「OIDCから着手する」を記録した");
  const detail = ok(await callTool(app, "get_activity", { projectId: project.id, activityId: canceled.id }, "worker-a"));
  assert.equal(detail.activity.body, "理由: 範囲を見直す");
  assert.equal(abandoned.summary, "Intent「認証を整備する」を放棄した");

  // Activityを保存できなければDirectionの状態変更も確定しない（同一transaction）。
  await sql`drop table activity`.execute(database);
  const failed = await send(app, "POST", `/api/projects/${project.id}/intents`, { title: "残らない", desiredState: "S" });
  assert.equal(failed.status, 500);
  const intents = (await sql<{ title: string }>`select title from intent where project_id = ${project.id}`.execute(database)).rows;
  assert.deepEqual(intents.map(({ title }) => title), ["認証を整備する"]);
  await database.destroy();
});

test("Role Contextは最近のActivity summaryを本文なしで返す", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "worker-a", "worker");
  ok(
    await record(app, "worker-a", {
      projectId: project.id,
      type: "handoff.note",
      summary: "次はcursorを確認する",
      body: "詳細",
      role: "worker",
      requestId: "r-1",
    }),
  );
  const context = ok(await callTool(app, "get_role_context", { projectId: project.id, role: "worker" }, "worker-a"));
  assert.deepEqual(context.unavailable, []);
  assert.deepEqual(context.activity.activities.map((item: { summary: string }) => item.summary), ["次はcursorを確認する"]);
  assert.equal(context.activity.activities[0].hasBody, true);
  assert.equal(JSON.stringify(context.activity).includes("詳細"), false, "本文は含めない");
  await database.destroy();
});

test("HumanはWeb APIからMembershipの認可でActivityの一覧・本文を確認できる", async () => {
  const { app, database } = await setup();
  const project = await createProject(app);
  await grant(app, project.id, "worker-a", "worker");
  const recorded = ok(
    await record(app, "worker-a", {
      projectId: project.id,
      type: "deliverable.published",
      summary: "設計文書を更新した",
      body: "差分は正本を参照",
      refs: [{ kind: "project_resource", resourceId: project.resources[0]!.id, path: "design.md" }],
      role: "worker",
      requestId: "r-1",
    }),
  );
  const listed = await send(app, "GET", `/api/projects/${project.id}/activities?limit=10`);
  assert.equal(listed.status, 200);
  const page = (await listed.json()) as { activities: { id: string; refs: unknown[] }[]; nextCursor: number | null };
  assert.deepEqual(page.activities.map(({ id }) => id), [recorded.activity.id]);
  assert.deepEqual(page.activities[0]!.refs, [{ kind: "project_resource", resourceId: project.resources[0]!.id, path: "design.md", revision: null }]);
  const detail = await send(app, "GET", `/api/projects/${project.id}/activities/${recorded.activity.id}`);
  assert.equal(detail.status, 200);
  assert.equal(((await detail.json()) as { activity: { body: string } }).activity.body, "差分は正本を参照");
  assert.equal((await send(app, "GET", `/api/projects/${project.id}/activities?limit=0`)).status, 400);
  assert.equal((await send(app, "GET", `/api/projects/missing/activities`)).status, 404);
  assert.equal((await send(app, "GET", `/api/projects/${project.id}/activities/missing`)).status, 404);
  await database.destroy();
});
