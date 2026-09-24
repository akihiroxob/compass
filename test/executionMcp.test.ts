import assert from "node:assert/strict";
import test from "node:test";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services) };
};

const rpc = (app: App, body: object, principal?: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
    },
    body: JSON.stringify(body),
  });

const readData = async (response: Response) => {
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

let rpcId = 0;
const callTool = async (app: App, name: string, args: object, principal?: string): Promise<ToolResult> => {
  const response = await rpc(app, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, principal);
  assert.equal(response.status, 200);
  return (await readData(response)).result;
};

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProject = async (app: App) =>
  ((await (await send(app, "POST", "/api/projects", { name: "Compass", mission: "Keep execution guarded" })).json()) as { project: { id: string } }).project.id;

const grant = (app: App, projectId: string, principalId: string, role: string) =>
  send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });

test("Direction toolsとExecution toolsが同じ/mcpから列挙され、tool名が衝突しない。serverはstatelessで単一", async () => {
  const { database, app } = await setup();
  const init = await rpc(app, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }, "worker-a");
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("mcp-session-id"), null);
  assert.equal((await readData(init)).result.serverInfo.name, "compass");

  const listed = await readData(await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  const names = (listed.result.tools as { name: string }[]).map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "tool名は一意");
  for (const direction of ["create_project", "list_projects", "get_project", "create_outcome", "decide_next_outcome", "fetch_runtime_events", "get_role_instructions"]) {
    assert.ok(names.includes(direction), direction);
  }
  for (const execution of ["issue_story", "issue_task", "list_tasks", "claim_task", "claim_review", "claim_acceptance", "accept_task", "reject_task", "list_changes"]) {
    assert.ok(names.includes(execution), execution);
  }
  // 旧Wachaの`list_projects`（Grant済みProject一覧）は移植せず、Directionの`list_projects`一つだけ。Skill系も範囲外。
  assert.equal(names.filter((name) => name === "list_projects").length, 1);
  assert.equal(names.includes("list_skills"), false);
  assert.equal(names.includes("get_skill_context"), false);
  await database.destroy();
});

test("Execution toolはBearerなしをUNAUTHENTICATEDにし、Directionの公開readはBearerなしのまま使える", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);

  const anonymous = await callTool(app, "list_tasks", { projectId });
  assert.equal(anonymous.isError, true);
  assert.equal(anonymous.structuredContent.error.code, "UNAUTHENTICATED");
  const anonymousWrite = await callTool(app, "issue_story", { projectId, title: "S", requestId: "r" });
  assert.equal(anonymousWrite.structuredContent.error.code, "UNAUTHENTICATED");

  const publicRead = await callTool(app, "get_project", { projectId });
  assert.equal(publicRead.isError, undefined);
  assert.equal(publicRead.structuredContent.id, projectId);

  // 形式が不正なBearerは、anonymousへ降格せずHTTP 401で拒否する（Direction toolと同じ）。
  const malformed = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(malformed.status, 401);
  await database.destroy();
});

test("PrincipalのGrantとClaim handleだけでTaskを進められ、認可エラーは旧Wachaと同じ構造化エラーで返る", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "manager-a", "manager");
  await grant(app, projectId, "worker-a", "worker");

  const story = await callTool(app, "issue_story", { projectId, title: "Story", requestId: "story-1" }, "manager-a");
  assert.equal(story.isError, undefined);
  assert.equal(story.structuredContent.requiredNextTool, "issue_task");
  const task = await callTool(app, "issue_task", { projectId, storyId: story.structuredContent.id, title: "Task A", requestId: "task-1" }, "manager-a");
  const taskId = task.structuredContent.id;

  const listed = await callTool(app, "list_tasks", { projectId, filter: { availableFor: "work" } }, "worker-a");
  assert.equal(listed.structuredContent.tasks[0].id, taskId);

  const claimed = await callTool(app, "claim_task", { taskId, requestId: "claim-1" }, "worker-a");
  assert.equal(claimed.isError, undefined);
  assert.equal(typeof claimed.structuredContent.claimId, "string");
  // 応答が失われた想定の再送は、同じClaimを返す。
  const replay = await callTool(app, "claim_task", { taskId, requestId: "claim-1" }, "worker-a");
  assert.equal(replay.structuredContent.claimId, claimed.structuredContent.claimId);

  const commented = await callTool(app, "add_task_comment", { taskId, claimId: claimed.structuredContent.claimId, body: "verified", requestId: "comment-1" }, "worker-a");
  assert.equal(commented.structuredContent.comment.principalId, "worker-a");

  // managerはworker Claimを取れない。構造化エラーで、本文は`CODE: message`。
  const denied = await callTool(app, "claim_task", { taskId, requestId: "claim-denied" }, "manager-a");
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "FORBIDDEN");
  assert.equal(denied.structuredContent.error.retryable, false);
  assert.match(denied.content[0]!.text, /^FORBIDDEN: /);

  const conflict = await callTool(app, "list_tasks", { projectId, filter: { status: ["todo"], availableFor: "work" } }, "worker-a");
  assert.equal(conflict.structuredContent.error.code, "INVALID_FILTER_COMBINATION");
  await database.destroy();
});

test("manager・worker・reviewerが統一MCPだけでStoryを完了まで進め、Change Logを増分取得できる", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  for (const [principal, role] of [["mgr", "manager"], ["wrk", "worker"], ["rev", "reviewer"], ["rt", "runtime"]] as const) {
    assert.equal((await grant(app, projectId, principal, role)).status, 201);
  }

  const story = (await callTool(app, "issue_story", { projectId, title: "Story", requestId: "s1" }, "mgr")).structuredContent;
  const task = (await callTool(app, "issue_task", { projectId, storyId: story.id, title: "Task", requestId: "t1" }, "mgr")).structuredContent;

  const work = (await callTool(app, "claim_task", { taskId: task.id, requestId: "w1" }, "wrk")).structuredContent;
  await callTool(app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "implemented", requestId: "w2" }, "wrk");
  await callTool(app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: "w3" }, "wrk");

  // 自己レビューはできない（workerがreviewerでもある場合の禁止は別テストで検証済み）。reviewerは別Principal。
  const review = (await callTool(app, "claim_review", { taskId: task.id, requestId: "r1" }, "rev")).structuredContent;
  await callTool(app, "reviewed_task", { taskId: task.id, claimId: review.claimId, requestId: "r2" }, "rev");
  const acceptance = (await callTool(app, "claim_acceptance", { taskId: task.id, requestId: "a1" }, "mgr")).structuredContent;
  const accepted = await callTool(app, "accept_task", { taskId: task.id, claimId: acceptance.claimId, requestId: "a2" }, "mgr");
  assert.equal(accepted.structuredContent.status, "accepted");

  const stories = (await callTool(app, "list_stories", { projectId }, "rt")).structuredContent.stories;
  assert.deepEqual(stories.map((item: { id: string; status: string }) => [item.id, item.status]), [[story.id, "done"]]);
  const comments = (await callTool(app, "list_task_comments", { taskId: task.id }, "rt")).structuredContent.comments;
  assert.equal(comments.length, 1);

  // Runtime（任意のGrantを持つPrincipal）はcursorで増分取得でき、cursorを進めれば重複しない。
  const first = (await callTool(app, "list_changes", { projectId, limit: 4 }, "rt")).structuredContent;
  assert.equal(first.changes.length, 4);
  const rest = (await callTool(app, "list_changes", { projectId, afterCursor: first.nextCursor }, "rt")).structuredContent;
  const all = [...first.changes, ...rest.changes].map((change: { type: string }) => change.type);
  assert.deepEqual(all, [
    "STORY_CREATED", "TASK_CREATED", "STORY_STARTED", "TASK_CLAIMED", "TASK_COMPLETED",
    "TASK_CLAIMED", "TASK_REVIEWED", "TASK_CLAIMED", "TASK_ACCEPTED", "STORY_COMPLETED",
  ]);
  const none = (await callTool(app, "list_changes", { projectId, afterCursor: rest.nextCursor }, "rt")).structuredContent;
  assert.deepEqual(none.changes, []);
  assert.equal(none.nextCursor, rest.nextCursor);

  // 別Projectのcursor・Grantでは読めない。
  const other = await createProject(app);
  const denied = await callTool(app, "list_changes", { projectId: other }, "rt");
  assert.equal(denied.structuredContent.error.code, "FORBIDDEN");
  await database.destroy();
});

test("manager・worker・reviewerのInstructionを既存のget_role_instructionsで取得できる（Bearer不要）", async () => {
  const { database, app } = await setup();
  for (const role of ["manager", "worker", "reviewer"]) {
    const result = await callTool(app, "get_role_instructions", { role, includeShared: true });
    assert.equal(result.isError, undefined, role);
    const files = result.structuredContent.files as { path: string; kind: string; content: string }[];
    assert.deepEqual(files.map((file) => [file.path, file.kind]), [["agent/role-policy.md", "shared"], [`agent/${role}.md`, "role"]]);
    assert.ok(files[1]!.content.length > 200, role);
  }
  const shared = (await callTool(app, "get_role_instructions", { role: "worker", includeShared: true })).structuredContent.files[0].content as string;
  assert.match(shared, /SELF_REVIEW_NOT_ALLOWED/);
  assert.match(shared, /IDEMPOTENCY_CONFLICT/);
  assert.match(shared, /list_changes/);
  await database.destroy();
});

test("manager・worker・reviewerのGrantはWeb APIで発行でき、MCPにGrant発行・取消のtoolは無い", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  for (const role of ["manager", "worker", "reviewer"]) {
    const created = await grant(app, projectId, `agent-${role}`, role);
    assert.equal(created.status, 201, role);
    assert.deepEqual(await (await send(app, "POST", `/api/projects/${projectId}/grants`, { principalId: `agent-${role}`, role })).json(), {
      grant: { projectId, principalId: `agent-${role}`, role, createdAt: ((await created.json()) as { grant: { createdAt: number } }).grant.createdAt },
      created: false,
    });
  }
  const listed = await readData(await rpc(app, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }));
  const names = (listed.result.tools as { name: string }[]).map((tool) => tool.name);
  assert.equal(names.some((name) => /grant|revoke/i.test(name)), false);
  await database.destroy();
});
