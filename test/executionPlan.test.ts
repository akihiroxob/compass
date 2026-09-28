import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { addTestMembership, createSignedInApp, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { humanProjectPermissions } from "../src/domain/model/HumanAuth.ts";

/**
 * Human operatorのStory・Task手動起票・編集Web API（Task 47。U4）。HumanはSession・Membership（editor以上）で起票し、
 * Outcome handoff（相関ID付きStory・taskKey付きTask）とAgent用MCPの契約は変わらないことを確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services), plain: createApp(services) };
};
type Kit = Awaited<ReturnType<typeof setup>>;

const callTool = async (app: App, name: string, args: object, principal: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${principal}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};
const ok = async (result: Promise<ToolResult>) => {
  const settled = await result;
  assert.equal(settled.isError, undefined, JSON.stringify(settled.structuredContent));
  return settled.structuredContent;
};

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const send = (method: "POST" | "PATCH", body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const storiesPath = (projectId: string, storyId?: string) => `/api/projects/${projectId}/stories${storyId ? `/${storyId}` : ""}`;
const tasksPath = (projectId: string, taskId?: string) => `/api/projects/${projectId}/tasks${taskId ? `/${taskId}` : ""}`;
const executionOf = async (kit: Kit, projectId: string) => json(await kit.app.request(`/api/projects/${projectId}/execution`));

/** Manager Grantと、MCPで作ったOutcome handoff相当（相関ID付き）のStory・taskKey付きTaskを用意する。 */
const seed = async (kit: Kit, name = "Compass") => {
  const { services, app } = kit;
  const project = await services.createProjectUseCase.execute({ name, mission: "Humans can plan work" });
  for (const [principalId, role] of [["mgr", "manager"], ["wrk", "worker"]] as const) {
    assert.equal((await app.request(`/api/projects/${project.id}/grants`, send("POST", { principalId, role }))).status, 201);
  }
  const handoffStory = await ok(callTool(app, "issue_story", { projectId: project.id, title: "Handoff", correlationId: "outcome:x", requestId: next("s") }, "mgr"));
  const handoffTask = await ok(callTool(app, "issue_task", { projectId: project.id, storyId: handoffStory.id, taskKey: "k1", title: "Handoff task", requestId: next("t") }, "mgr"));
  return { project, handoffStory, handoffTask };
};

test("権限表: Execution手動起票はeditor以上", () => {
  assert.equal(humanProjectPermissions["execution.plan"], "editor");
});

test("editorがStory・Taskを起票・編集でき、operatorとしてSTORY_CREATED・TASK_CREATEDを残し、Agentが引き受けられる", async () => {
  const kit = await setup();
  const { project } = await seed(kit);
  const editor = await createTestHuman(kit.database);
  await addTestMembership(kit.database, project.id, editor, "editor");
  const asEditor = requestAs(kit.plain, editor);

  const storyResponse = await asEditor(storiesPath(project.id), send("POST", { title: "  Manual story  ", description: "" }));
  assert.equal(storyResponse.status, 201);
  const { story } = await json(storyResponse);
  assert.equal(story.title, "Manual story");
  assert.equal(story.description, null);
  assert.equal(story.correlationId, null);
  assert.equal(story.outcomeId, null);

  const taskResponse = await asEditor(tasksPath(project.id), send("POST", { title: "Manual task", description: "Do it", storyId: story.id }));
  assert.equal(taskResponse.status, 201);
  const { task } = await json(taskResponse);
  assert.equal(task.storyId, story.id);
  assert.equal(task.taskKey, null);
  assert.equal(task.status, "todo");
  // Storyを選ばないTaskも作れる（Storyに属さないTask）。
  const loose = await json(await asEditor(tasksPath(project.id), send("POST", { title: "Loose task", storyId: "" })));
  assert.equal(loose.task.storyId, null);

  const changes = (await json(await asEditor(`/api/projects/${project.id}/changes?limit=3`))).changes;
  assert.deepEqual(changes.map((change: any) => [change.type, change.entityId]), [["TASK_CREATED", loose.task.id], ["TASK_CREATED", task.id], ["STORY_CREATED", story.id]]);
  for (const change of changes) {
    assert.equal(change.principalId, `human:${editor.humanUserId}`);
    assert.equal(change.payload.actorRole, "operator");
    assert.equal(change.correlationId, undefined);
  }
  assert.equal(changes[1].payload.storyId, story.id);

  const editedStory = await json(await asEditor(storiesPath(project.id, story.id), send("PATCH", { title: "Renamed story", description: "Why" })));
  assert.equal(editedStory.story.title, "Renamed story");
  assert.equal(editedStory.story.description, "Why");
  const editedTask = await json(await asEditor(tasksPath(project.id, task.id), send("PATCH", { title: "Renamed task", description: "" })));
  assert.equal(editedTask.task.title, "Renamed task");
  assert.equal(editedTask.task.description, null);
  assert.equal(editedTask.task.storyId, story.id);
  // 編集はMCPのedit_*と同じくChange Logを残さない（list_changesの種別を増やさない）。
  assert.equal((await json(await asEditor(`/api/projects/${project.id}/changes?limit=1`))).changes[0].entityId, loose.task.id);

  // Agentは既存のMCPで手動起票のTaskを一覧・Claimできる。
  const listed = await ok(callTool(kit.app, "list_tasks", { projectId: project.id, filter: { availableFor: "work" } }, "wrk"));
  assert.ok(listed.tasks.some((item: any) => item.id === task.id && item.title === "Renamed task"));
  await ok(callTool(kit.app, "claim_task", { taskId: task.id, requestId: next("c") }, "wrk"));
});

test("Outcome handoffのStory・Taskは編集・配下起票できず、handoffの冪等な再送は既存の内容へ収束する", async () => {
  const kit = await setup();
  const { project, handoffStory, handoffTask } = await seed(kit);
  const cases: [string, RequestInit][] = [
    [storiesPath(project.id, handoffStory.id), send("PATCH", { title: "Changed" })],
    [tasksPath(project.id, handoffTask.id), send("PATCH", { title: "Changed" })],
    [tasksPath(project.id), send("POST", { title: "Extra", storyId: handoffStory.id })],
  ];
  for (const [path, init] of cases) {
    const response = await kit.app.request(path, init);
    assert.equal(response.status, 409, path);
    assert.equal((await json(response)).error.conflict, "HANDOFF_MANAGED");
  }
  const execution = await executionOf(kit, project.id);
  assert.equal(execution.stories.find((story: any) => story.id === handoffStory.id).title, "Handoff");
  assert.deepEqual(execution.tasks.map((task: any) => task.title), ["Handoff task"]);
  // Managerの再送（新しいrequestId）は、同じStory・Taskを返す。
  const story = await ok(callTool(kit.app, "issue_story", { projectId: project.id, title: "Handoff", correlationId: "outcome:x", requestId: next("s") }, "mgr"));
  assert.equal(story.id, handoffStory.id);
  const task = await ok(callTool(kit.app, "issue_task", { projectId: project.id, storyId: handoffStory.id, taskKey: "k1", title: "Handoff task", requestId: next("t") }, "mgr"));
  assert.equal(task.id, handoffTask.id);
});

test("不正入力・相関ID・taskKeyは400、別ProjectのStoryは400、完了・取消のStory・Taskは409で、何も作らない", async () => {
  const kit = await setup();
  const alpha = await seed(kit, "Alpha");
  const beta = await seed(kit, "Beta");
  const projectId = alpha.project.id;
  const invalid: [string, RequestInit, string][] = [
    [storiesPath(projectId), send("POST", {}), "title"],
    [storiesPath(projectId), send("POST", { title: "   " }), "title"],
    [storiesPath(projectId), send("POST", { title: "x".repeat(201) }), "title"],
    [storiesPath(projectId), send("POST", { title: "S", correlationId: "outcome:y" }), ""],
    [tasksPath(projectId), send("POST", { title: "T", taskKey: "k" }), ""],
    [tasksPath(projectId), send("POST", { title: 1 }), "title"],
    [tasksPath(projectId), send("POST", { title: "T", storyId: beta.handoffStory.id }), "storyId"],
    [tasksPath(projectId), send("POST", { title: "T", storyId: "missing" }), "storyId"],
    [tasksPath(projectId, alpha.handoffTask.id), send("PATCH", { title: "T", storyId: null }), ""],
    [storiesPath(projectId), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, ""],
  ];
  for (const [path, init, issuePath] of invalid) {
    const response = await kit.app.request(path, init);
    assert.equal(response.status, 400, `${path} ${init.body}`);
    const { error } = await json(response);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.ok(error.issues.some((issue: any) => issue.path === issuePath), JSON.stringify(error.issues));
  }
  // 別ProjectのStory・Task IDでの編集は404。
  for (const path of [storiesPath(projectId, beta.handoffStory.id), tasksPath(projectId, beta.handoffTask.id), storiesPath(projectId, "missing"), tasksPath(projectId, "missing")]) {
    assert.equal((await kit.app.request(path, send("PATCH", { title: "X" }))).status, 404, path);
  }

  // 完了・取消のStoryへは追加・編集しない。取消済みTaskは編集しない。
  const { story } = await json(await kit.app.request(storiesPath(projectId), send("POST", { title: "Closing" })));
  const { task } = await json(await kit.app.request(tasksPath(projectId), send("POST", { title: "Only", storyId: story.id })));
  await ok(callTool(kit.app, "claim_task", { taskId: task.id, requestId: next("c") }, "wrk"));
  assert.equal((await kit.app.request(tasksPath(projectId, task.id) + "/cancel", send("POST", { reason: "stop" }))).status, 200);
  const edited = await kit.app.request(tasksPath(projectId, task.id), send("PATCH", { title: "X" }));
  assert.equal(edited.status, 409);
  assert.equal((await json(edited)).error.conflict, "INVALID_TASK_STATUS");
  const cancelStory = await ok(callTool(kit.app, "cancel_story", { storyId: story.id, reason: "stop", requestId: next("x") }, "mgr"));
  assert.equal(cancelStory.status, "canceled");
  for (const [path, init] of [[storiesPath(projectId, story.id), send("PATCH", { title: "X" })], [tasksPath(projectId), send("POST", { title: "X", storyId: story.id })]] as const) {
    const response = await kit.app.request(path, init);
    assert.equal(response.status, 409, path);
    assert.equal((await json(response)).error.conflict, "STORY_CLOSED");
  }
  const execution = await executionOf(kit, projectId);
  assert.deepEqual(execution.stories.map((item: any) => item.title), ["Handoff", "Closing"]);
  assert.deepEqual(execution.tasks.map((item: any) => item.title), ["Handoff task", "Only"]);
  assert.deepEqual((await executionOf(kit, beta.project.id)).tasks.map((item: any) => item.title), ["Handoff task"]);
});

test("owner・administrator・editorは起票でき、viewerは403・未所属は404・archivedは409で、何も作らない", async () => {
  const kit = await setup();
  const { project } = await seed(kit);
  const humans: Record<string, TestHuman> = {};
  for (const role of ["owner", "administrator", "editor", "viewer"] as const) {
    humans[role] = await createTestHuman(kit.database);
    await addTestMembership(kit.database, project.id, humans[role]!, role);
  }
  humans.outsider = await createTestHuman(kit.database);
  const { story } = await json(await kit.app.request(storiesPath(project.id), send("POST", { title: "Base" })));
  const { task } = await json(await kit.app.request(tasksPath(project.id), send("POST", { title: "Base task", storyId: story.id })));
  const requests: [string, RequestInit][] = [
    [storiesPath(project.id), send("POST", { title: "New" })],
    [storiesPath(project.id, story.id), send("PATCH", { title: "New" })],
    [tasksPath(project.id), send("POST", { title: "New", storyId: story.id })],
    [tasksPath(project.id, task.id), send("PATCH", { title: "New" })],
  ];
  const snapshot = async () => JSON.stringify(await executionOf(kit, project.id));
  const before = await snapshot();
  for (const [who, status, code] of [["viewer", 403, "FORBIDDEN"], ["outsider", 404, "NOT_FOUND"]] as const) {
    for (const [path, init] of requests) {
      const response = await requestAs(kit.plain, humans[who]!)(path, init);
      assert.equal(response.status, status, `${who} ${init.method} ${path}`);
      assert.equal((await json(response)).error.code, code);
    }
  }
  assert.equal((await kit.plain.request(storiesPath(project.id), send("POST", { title: "New" }))).status, 401);
  assert.equal(await snapshot(), before);

  for (const role of ["owner", "administrator", "editor"] as const) {
    for (const [path, init] of requests) {
      const response = await requestAs(kit.plain, humans[role]!)(path, init);
      assert.equal(response.status, init.method === "POST" ? 201 : 200, `${role} ${init.method} ${path}`);
    }
  }

  assert.equal((await kit.app.request(`/api/projects/${project.id}/archive`, send("POST", { reason: "done" }))).status, 200);
  const archivedBefore = await snapshot();
  for (const [path, init] of requests) {
    const response = await kit.app.request(path, init);
    assert.equal(response.status, 409, `${init.method} ${path}`);
    assert.equal((await json(response)).error.projectStatus, "archived");
  }
  assert.equal(await snapshot(), archivedBefore);
});

test("Human手動起票はMCPへ公開しない", async () => {
  const kit = await setup();
  const response = await kit.app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer mgr" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  const names: string[] = JSON.parse(data.slice(6)).result.tools.map((tool: { name: string }) => tool.name);
  for (const name of names) assert.doesNotMatch(name, /operator|human/i);
  assert.ok(names.includes("issue_story") && names.includes("issue_task"));
});
