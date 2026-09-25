import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { addTestMembership, createSignedInApp, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { humanProjectPermissions } from "../src/domain/model/HumanAuth.ts";

/**
 * Human operatorのExecution介入Web API（Task 46。受入・差戻し・取消・Comment）。Story・Task・ClaimはMCP（Agent）で作り、
 * HumanはSession・Membership（editor以上）でWeb APIから介入する。Agent用MCPの契約が変わらないことも確認する。
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

/** 状態ごとのTask（todo・doing・in_review・wait_accept）と、それを作ったAgentを用意する。 */
const seed = async (kit: Kit, name = "Compass") => {
  const { services, app } = kit;
  const project = await services.createProjectUseCase.execute({ name, mission: "Humans can intervene" });
  for (const [principalId, role] of [["mgr", "manager"], ["wrk", "worker"], ["rev", "reviewer"]] as const) {
    assert.equal((await app.request(`/api/projects/${project.id}/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId, role }) })).status, 201);
  }
  const story = await ok(callTool(app, "issue_story", { projectId: project.id, title: "Story", requestId: next("s") }, "mgr"));
  const issue = async (title: string) => ok(callTool(app, "issue_task", { projectId: project.id, storyId: story.id, title, requestId: next("t") }, "mgr"));
  const complete = async (taskId: string) => {
    const work = await ok(callTool(app, "claim_task", { taskId, requestId: next("c") }, "wrk"));
    await ok(callTool(app, "add_task_comment", { taskId, claimId: work.claimId, body: "done", requestId: next("m") }, "wrk"));
    await ok(callTool(app, "complete_task", { taskId, claimId: work.claimId, requestId: next("d") }, "wrk"));
  };
  const todo = await issue("Todo task");
  const doing = await issue("Doing task");
  const doingClaim = await ok(callTool(app, "claim_task", { taskId: doing.id, requestId: next("c") }, "wrk"));
  const inReview = await issue("In review task");
  await complete(inReview.id);
  const waitAccept = await issue("Wait accept task");
  await complete(waitAccept.id);
  const review = await ok(callTool(app, "claim_review", { taskId: waitAccept.id, requestId: next("r") }, "rev"));
  await ok(callTool(app, "reviewed_task", { taskId: waitAccept.id, claimId: review.claimId, requestId: next("v") }, "rev"));
  return { project, story, todo, doing, doingClaim, inReview, waitAccept };
};

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const post = (body?: unknown): RequestInit =>
  body === undefined ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
const taskPath = (projectId: string, taskId: string, action = "") => `/api/projects/${projectId}/tasks/${taskId}${action}`;
const detailOf = async (kit: Kit, projectId: string, taskId: string) => json(await kit.app.request(taskPath(projectId, taskId)));

test("権限表: Execution介入はeditor以上", () => {
  assert.equal(humanProjectPermissions["execution.intervene"], "editor");
});

test("editorがwait_accept・in_reviewのTaskを受け入れ、operatorとして監査可能なChangeを残し、Storyを完了させる", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const editor = await createTestHuman(kit.database);
  await addTestMembership(kit.database, seeded.project.id, editor, "editor");
  const asEditor = requestAs(kit.plain, editor);
  // 残りのTaskを先に取り消し、最後の受入でStoryが完了することを確かめる（取消ではStoryを完了させない既存規則）。
  for (const task of [seeded.todo, seeded.doing]) {
    assert.equal((await asEditor(taskPath(seeded.project.id, task.id, "/cancel"), post({ reason: "not needed" }))).status, 200);
  }

  for (const task of [seeded.waitAccept, seeded.inReview]) {
    const response = await asEditor(taskPath(seeded.project.id, task.id, "/accept"), post());
    assert.equal(response.status, 200);
    assert.equal((await json(response)).status, "accepted");
    const detail = await detailOf(kit, seeded.project.id, task.id);
    assert.equal(detail.task.status, "accepted");
    assert.equal(detail.task.activeClaim, null);
    const [claimed, accepted] = detail.changes.slice(-2);
    assert.equal(claimed.type, "TASK_CLAIMED");
    assert.equal(accepted.type, "TASK_ACCEPTED");
    for (const change of [claimed, accepted]) {
      assert.equal(change.principalId, `human:${editor.humanUserId}`);
      assert.equal(change.payload.actorRole, "operator");
    }
    assert.equal(accepted.claimId, claimed.claimId);
    assert.equal(claimed.payload.path, task === seeded.inReview ? "operator_direct_review" : "reviewer_approved");
  }
  // Storyの全Taskが終端になれば、Agentの受入と同じくStoryを完了する。
  const execution = await json(await asEditor(`/api/projects/${seeded.project.id}/execution`));
  assert.equal(execution.stories[0].status, "done");
});

test("差戻し・取消は理由必須で、空・空白だけの理由は400で状態を変えない", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const projectId = seeded.project.id;
  for (const [action, taskId] of [["/reject", seeded.inReview.id], ["/cancel", seeded.todo.id]] as const) {
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 1 }]) {
      const response = await kit.app.request(taskPath(projectId, taskId, action), post(body));
      assert.equal(response.status, 400, `${action} ${JSON.stringify(body)}`);
      const error = (await json(response)).error;
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.issues[0].path, "reason");
    }
    const invalidJson = await kit.app.request(taskPath(projectId, taskId, action), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(invalidJson.status, 400);
  }
  const blankComment = await kit.app.request(taskPath(projectId, seeded.todo.id, "/comments"), post({ body: "  " }));
  assert.equal(blankComment.status, 400);
  assert.equal((await json(blankComment)).error.issues[0].path, "body");
  assert.equal((await detailOf(kit, projectId, seeded.inReview.id)).task.status, "in_review");
  const todo = await detailOf(kit, projectId, seeded.todo.id);
  assert.equal(todo.task.status, "todo");
  assert.deepEqual(todo.comments, []);

  // 理由は前後の空白を除いて保存し、Change Logにも残る。
  const rejected = await kit.app.request(taskPath(projectId, seeded.inReview.id, "/reject"), post({ reason: "  tests missing  " }));
  assert.equal(rejected.status, 200);
  const detail = await detailOf(kit, projectId, seeded.inReview.id);
  assert.equal(detail.task.status, "rejected");
  assert.equal(detail.task.rejectReason, "tests missing");
  assert.equal(detail.changes.at(-1).type, "TASK_REJECTED");
  assert.equal(detail.changes.at(-1).payload.reason, "tests missing");
  assert.equal(detail.changes.at(-1).payload.actorRole, "operator");
});

test("取消はtodo・doingだけで、doingのAgent Claimを同じtransactionで解放し、古いClaimでの操作を拒否する", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const projectId = seeded.project.id;
  const response = await kit.app.request(taskPath(projectId, seeded.doing.id, "/cancel"), post({ reason: "direction changed" }));
  assert.equal(response.status, 200);
  const detail = await detailOf(kit, projectId, seeded.doing.id);
  assert.equal(detail.task.status, "canceled");
  assert.equal(detail.task.activeClaim, null);
  const canceled = detail.changes.at(-1);
  assert.equal(canceled.type, "TASK_CANCELED");
  assert.equal(canceled.claimId, seeded.doingClaim.claimId);
  assert.equal(canceled.payload.reason, "direction changed");
  // Workerの古いClaimはfenceされる。
  const stale = await callTool(kit.app, "complete_task", { taskId: seeded.doing.id, claimId: seeded.doingClaim.claimId, requestId: next("d") }, "wrk");
  assert.equal(stale.isError, true);
});

test("不正な状態・Claim中の競合は409で、状態・Change・Commentを変えない", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const projectId = seeded.project.id;
  const cases: [string, string, unknown, string][] = [
    ["/accept", seeded.todo.id, undefined, "TASK_NOT_CLAIMABLE"],
    ["/reject", seeded.doing.id, { reason: "no" }, "CLAIM_CONFLICT"],
    ["/cancel", seeded.inReview.id, { reason: "no" }, "INVALID_TASK_STATUS"],
  ];
  // reviewerがClaim中（期限内）のTaskは、受入・差戻しできない（先にClaimした側を優先する）。
  await ok(callTool(kit.app, "claim_review", { taskId: seeded.inReview.id, requestId: next("r") }, "rev"));
  cases.push(["/accept", seeded.inReview.id, undefined, "CLAIM_CONFLICT"], ["/reject", seeded.inReview.id, { reason: "no" }, "CLAIM_CONFLICT"]);
  const before = await json(await kit.app.request(`/api/projects/${projectId}/changes?limit=100`));
  for (const [action, taskId, body, conflict] of cases) {
    const response = await kit.app.request(taskPath(projectId, taskId, action), post(body));
    assert.equal(response.status, 409, `${action} ${taskId}`);
    const error = (await json(response)).error;
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.conflict, conflict, `${action} ${taskId}`);
  }
  const after = await json(await kit.app.request(`/api/projects/${projectId}/changes?limit=100`));
  assert.deepEqual(after.changes, before.changes);

  // 受入済みのTaskを別のHumanが（古い画面から）受入・差戻ししても、二重に遷移しない。
  assert.equal((await kit.app.request(taskPath(projectId, seeded.waitAccept.id, "/accept"), post())).status, 200);
  assert.equal((await kit.app.request(taskPath(projectId, seeded.waitAccept.id, "/accept"), post())).status, 409);
  assert.equal((await kit.app.request(taskPath(projectId, seeded.waitAccept.id, "/reject"), post({ reason: "late" }))).status, 409);
  assert.equal((await detailOf(kit, projectId, seeded.waitAccept.id)).task.status, "accepted");
});

test("CommentはClaimに紐づかず、HumanのPrincipalで残り、Agentのcomplete_taskの作業記録にならない", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const projectId = seeded.project.id;
  const response = await kit.app.request(taskPath(projectId, seeded.doing.id, "/comments"), post({ body: "  Please add tests  " }));
  assert.equal(response.status, 201);
  const { comment } = await json(response);
  assert.equal(comment.body, "Please add tests");
  assert.equal(comment.claimId, null);
  assert.equal(comment.principalId, `human:${kit.app.human.humanUserId}`);
  const detail = await detailOf(kit, projectId, seeded.doing.id);
  assert.deepEqual(detail.comments.map((item: any) => [item.body, item.principalId, item.claimId]), [["Please add tests", comment.principalId, null]]);
  // Change Logの種別は増やさない（MCP list_changesの契約を変えない）。
  assert.equal(detail.changes.at(-1).type, "TASK_CLAIMED");
  // WorkerのClaimに紐づくCommentが無いため、complete_taskは従来どおり拒否される。
  const completed = await callTool(kit.app, "complete_task", { taskId: seeded.doing.id, claimId: seeded.doingClaim.claimId, requestId: next("d") }, "wrk");
  assert.equal(completed.isError, true);
  // MCPのlist_task_commentsでもHumanのCommentを読める（同じtask_comment）。
  const listed = await ok(callTool(kit.app, "list_task_comments", { taskId: seeded.doing.id }, "wrk"));
  assert.deepEqual(listed.comments.map((item: any) => item.body), ["Please add tests"]);
});

test("owner・administrator・editorは介入でき、viewer・未所属は拒否され、状態を変えない", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const projectId = seeded.project.id;
  const humans: Record<string, TestHuman> = {};
  for (const role of ["owner", "administrator", "editor", "viewer"] as const) {
    humans[role] = await createTestHuman(kit.database);
    await addTestMembership(kit.database, projectId, humans[role]!, role);
  }
  humans.outsider = await createTestHuman(kit.database);
  const requests: [string, string, unknown][] = [
    ["/accept", seeded.waitAccept.id, undefined],
    ["/reject", seeded.inReview.id, { reason: "no" }],
    ["/cancel", seeded.todo.id, { reason: "no" }],
    ["/comments", seeded.todo.id, { body: "hello" }],
  ];
  for (const [who, status, code] of [["viewer", 403, "FORBIDDEN"], ["outsider", 404, "NOT_FOUND"]] as const) {
    for (const [action, taskId, body] of requests) {
      const response = await requestAs(kit.plain, humans[who]!)(taskPath(projectId, taskId, action), post(body));
      assert.equal(response.status, status, `${who} ${action}`);
      assert.equal((await json(response)).error.code, code);
    }
  }
  // Session無しは401。
  assert.equal((await kit.plain.request(taskPath(projectId, seeded.todo.id, "/comments"), post({ body: "x" }))).status, 401);
  assert.equal((await detailOf(kit, projectId, seeded.waitAccept.id)).task.status, "wait_accept");
  assert.equal((await detailOf(kit, projectId, seeded.inReview.id)).task.status, "in_review");
  assert.equal((await detailOf(kit, projectId, seeded.todo.id)).task.status, "todo");
  assert.deepEqual((await detailOf(kit, projectId, seeded.todo.id)).comments, []);

  for (const role of ["owner", "administrator", "editor"] as const) {
    const response = await requestAs(kit.plain, humans[role]!)(taskPath(projectId, seeded.todo.id, "/comments"), post({ body: `from ${role}` }));
    assert.equal(response.status, 201, role);
  }
});

test("別ProjectのTask ID・存在しないTaskは404、archived Projectは409で、状態を変えない", async () => {
  const kit = await setup();
  const alpha = await seed(kit, "Alpha");
  const beta = await seed(kit, "Beta");
  for (const [action, body] of [["/accept", undefined], ["/reject", { reason: "no" }], ["/cancel", { reason: "no" }], ["/comments", { body: "x" }]] as const) {
    for (const taskId of [beta.waitAccept.id, "missing"]) {
      const response = await kit.app.request(taskPath(alpha.project.id, taskId, action), post(body));
      assert.equal(response.status, 404, `${action} ${taskId}`);
    }
  }
  assert.equal((await detailOf(kit, beta.project.id, beta.waitAccept.id)).task.status, "wait_accept");

  assert.equal((await kit.app.request(`/api/projects/${alpha.project.id}/archive`, post({ reason: "done" }))).status, 200);
  for (const [action, taskId, body] of [
    ["/accept", alpha.waitAccept.id, undefined],
    ["/reject", alpha.inReview.id, { reason: "no" }],
    ["/cancel", alpha.todo.id, { reason: "no" }],
    ["/comments", alpha.todo.id, { body: "x" }],
  ] as const) {
    const response = await kit.app.request(taskPath(alpha.project.id, taskId, action), post(body));
    assert.equal(response.status, 409, action);
    assert.equal((await json(response)).error.projectStatus, "archived");
  }
  assert.equal((await detailOf(kit, alpha.project.id, alpha.waitAccept.id)).task.status, "wait_accept");
  assert.deepEqual((await detailOf(kit, alpha.project.id, alpha.todo.id)).comments, []);
});

test("Agent用MCPの自己受入禁止は維持され、Human介入のtoolはMCPに公開しない", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  // wrkにmanagerを追加しても、自分が完了したTaskは受け入れられない（既存の規則）。
  assert.equal((await kit.app.request(`/api/projects/${seeded.project.id}/grants`, post({ principalId: "wrk", role: "manager" }))).status, 201);
  const self = await callTool(kit.app, "claim_acceptance", { taskId: seeded.waitAccept.id, requestId: next("a") }, "wrk");
  assert.equal(self.isError, true);
  assert.equal(self.structuredContent.error?.code ?? self.structuredContent.code, "SELF_ACCEPTANCE_NOT_ALLOWED");
  const listed = await kit.app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer mgr" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const data = (await listed.text()).split("\n").find((line) => line.startsWith("data: "))!;
  const names: string[] = JSON.parse(data.slice(6)).result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes("accept_task"));
  assert.deepEqual(names.filter((name) => /operator/i.test(name)), []);
});
