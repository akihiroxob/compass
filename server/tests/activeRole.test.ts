import assert from "node:assert/strict";
import test from "node:test";
import type { createApp } from "../src/bootstrap/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

/**
 * 操作ContextのactiveRole（`X-Compass-Active-Role`。docs/architecture-migration-mapping.md）。
 * headerがあれば`principalId + projectId + activeRole`のGrantだけで認可し、同じPrincipalの他Grantを合算しない。
 * headerなしは従来どおり操作ごとに必要Roleを検査する（互換）。
 */
type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services) };
};

const agentHeaders = (principal?: string, activeRole?: string): Record<string, string> => ({
  ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
  ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
});

const rpc = (app: App, body: object, principal?: string, activeRole?: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...agentHeaders(principal, activeRole),
    },
    body: JSON.stringify(body),
  });

const readData = async (response: Response) => {
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

let rpcId = 0;
const callTool = async (app: App, name: string, args: object, principal?: string, activeRole?: string): Promise<ToolResult> => {
  const response = await rpc(
    app,
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
    principal,
    activeRole,
  );
  assert.equal(response.status, 200);
  return (await readData(response)).result;
};

const send = (app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProject = async (app: App, name = "Compass") =>
  ((await (await send(app, "POST", "/api/projects", { name, mission: "Keep execution guarded" })).json()) as { project: { id: string } }).project.id;

const grant = async (app: App, projectId: string, principalId: string, ...roles: string[]) => {
  for (const role of roles) {
    const response = await send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });
    assert.ok(response.status === 200 || response.status === 201);
  }
};

const issueTask = async (app: App, projectId: string, title = "Task A") => {
  await grant(app, projectId, "planner", "manager");
  const issued = await callTool(app, "issue_task", { projectId, title, requestId: `issue-${title}` }, "planner");
  assert.equal(issued.isError, undefined);
  return issued.structuredContent.id as string;
};

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return result.structuredContent.error.code;
};

test("activeRoleを指定すると、同じPrincipalの他Grantを合算せずそのRoleだけで認可する", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const taskId = await issueTask(app, projectId);
  await grant(app, projectId, "multi", "worker", "manager");

  const asManager = await callTool(app, "list_tasks", { projectId, filter: { availableFor: "work" } }, "multi", "manager");
  assert.deepEqual(asManager.structuredContent.tasks, []);
  assert.equal(errorCode(await callTool(app, "claim_task", { taskId, requestId: "claim-m" }, "multi", "manager")), "FORBIDDEN");
  // Grantの無いRoleでは参照も拒否する。
  assert.equal(errorCode(await callTool(app, "list_tasks", { projectId }, "multi", "reviewer")), "FORBIDDEN");

  const asWorker = await callTool(app, "list_tasks", { projectId, filter: { availableFor: "work" } }, "multi", "worker");
  assert.deepEqual(asWorker.structuredContent.tasks.map((task: { id: string }) => task.id), [taskId]);
  const claimed = await callTool(app, "claim_task", { taskId, requestId: "claim-w" }, "multi", "worker");
  assert.equal(claimed.isError, undefined);
  await database.destroy();
});

test("activeRole headerなしは従来どおり操作ごとに必要Roleを検査する", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const taskId = await issueTask(app, projectId);
  await grant(app, projectId, "multi", "worker", "manager");

  const listed = await callTool(app, "list_tasks", { projectId, filter: { availableFor: "work" } }, "multi");
  assert.deepEqual(listed.structuredContent.tasks.map((task: { id: string }) => task.id), [taskId]);
  assert.equal((await callTool(app, "claim_task", { taskId, requestId: "claim" }, "multi")).isError, undefined);
  await database.destroy();
});

test("不正なactiveRoleはRoleなしへ降格せず400で拒否する", async () => {
  const { database, app } = await setup();
  const response = await rpc(
    app,
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "list_projects", arguments: {} } },
    "multi",
    "admin",
  );
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: { message: string } }).error.message, /X-Compass-Active-Role/);
  await database.destroy();
});

test("Roleを切り替えても自己レビュー・自己受入の禁止は回避できない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const taskId = await issueTask(app, projectId);
  await grant(app, projectId, "multi", "worker", "reviewer", "manager");

  const claim = await callTool(app, "claim_task", { taskId, requestId: "work" }, "multi", "worker");
  const claimId = claim.structuredContent.claimId;
  await callTool(app, "add_task_comment", { taskId, claimId, body: "verified", requestId: "comment" }, "multi", "worker");
  assert.equal((await callTool(app, "complete_task", { taskId, claimId, requestId: "complete" }, "multi", "worker")).isError, undefined);

  assert.equal(
    errorCode(await callTool(app, "claim_review", { taskId, requestId: "review" }, "multi", "reviewer")),
    "SELF_REVIEW_NOT_ALLOWED",
  );
  assert.equal(
    errorCode(await callTool(app, "claim_acceptance", { taskId, requestId: "acceptance" }, "multi", "manager")),
    "SELF_ACCEPTANCE_NOT_ALLOWED",
  );
  await database.destroy();
});

test("同じrequestIdを異なるactiveRoleで再送すると既存結果を返さずIDEMPOTENCY_CONFLICTにする", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  const taskId = await issueTask(app, projectId);
  await grant(app, projectId, "worker-a", "worker");

  const first = await callTool(app, "claim_task", { taskId, requestId: "claim" }, "worker-a", "worker");
  const resent = await callTool(app, "claim_task", { taskId, requestId: "claim" }, "worker-a", "worker");
  assert.deepEqual(resent.structuredContent, first.structuredContent);
  assert.equal(errorCode(await callTool(app, "claim_task", { taskId, requestId: "claim" }, "worker-a")), "IDEMPOTENCY_CONFLICT");
  await database.destroy();
});

test("Direction toolもactiveRoleのRoleだけで認可し、別RoleのContextを読ませない", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "director", "strategist", "researcher");

  const denied = await callTool(app, "get_strategist_context", { projectId }, "director", "researcher");
  assert.equal(errorCode(denied), "FORBIDDEN");
  assert.equal(denied.structuredContent.error.activeRole, "researcher");
  assert.equal(denied.structuredContent.error.requiredRole, "strategist");
  assert.equal((await callTool(app, "get_strategist_context", { projectId }, "director", "strategist")).isError, undefined);
  assert.equal((await callTool(app, "get_strategist_context", { projectId }, "director")).isError, undefined);
  await database.destroy();
});

test("activeRoleでも職務分離は緩めず、Grantの無いactiveRoleでの管理操作も拒否する", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "mixed", "strategist", "manager");
  await grant(app, projectId, "manager-only", "manager");

  const update = (principal: string, activeRole?: string) =>
    callTool(app, "update_project", { projectId, description: "updated" }, principal, activeRole);
  assert.equal(errorCode(await update("mixed", "manager")), "FORBIDDEN");
  assert.equal(errorCode(await update("manager-only", "worker")), "FORBIDDEN");
  assert.equal((await update("manager-only", "manager")).isError, undefined);
  await database.destroy();
});

test("activeRole指定時はPrincipalなしの管理操作を拒否し、headerなし匿名の互換は維持する", async () => {
  const { database, app, services } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "manager-only", "manager");
  const intentInput = { projectId, title: "Intent", desiredState: "done" };

  // Bearerなし＋activeRoleはGrant検査の対象Principalが無いためUNAUTHENTICATED。Projectは変更されない。
  const anonymousUpdate = await callTool(app, "update_project", { projectId, description: "changed anonymously" }, undefined, "manager");
  assert.equal(errorCode(anonymousUpdate), "UNAUTHENTICATED");
  assert.equal(errorCode(await callTool(app, "create_intent", intentInput, undefined, "manager")), "UNAUTHENTICATED");
  assert.notEqual((await services.getProjectUseCase.execute(projectId)).description, "changed anonymously");
  assert.deepEqual((await callTool(app, "list_intents", { projectId }, "manager-only", "manager")).structuredContent.intents, []);

  // Grant保持者はactiveRole付きで管理操作できる。
  assert.equal((await callTool(app, "create_intent", intentInput, "manager-only", "manager")).isError, undefined);
  assert.equal(
    (await callTool(app, "update_project", { projectId, description: "by manager" }, "manager-only", "manager")).isError,
    undefined,
  );

  // headerなし匿名は従来どおり管理操作できる（互換）。
  assert.equal((await callTool(app, "update_project", { projectId, description: "anonymous compat" })).isError, undefined);
  assert.equal((await services.getProjectUseCase.execute(projectId)).description, "anonymous compat");
  await database.destroy();
});

test("Grant済みProjectの一覧はactiveRoleのGrantがあるProjectだけに絞る", async () => {
  const { database, app, services } = await setup();
  const workerProject = await createProject(app, "Worker");
  const managerProject = await createProject(app, "Manager");
  await grant(app, workerProject, "multi", "worker");
  await grant(app, managerProject, "multi", "manager");

  assert.deepEqual(
    (await services.projectAuthorizationService.listGrantedProjectIds("multi")).sort(),
    [workerProject, managerProject].sort(),
  );
  assert.deepEqual(
    await services.forActiveRole("worker").projectAuthorizationService.listGrantedProjectIds("multi"),
    [workerProject],
  );
  await database.destroy();
});

test("trusted-localでもactiveRole指定時はDirection参照・一覧にそのRoleのProject Grantを要求する", async () => {
  const { database, app } = await setup();
  const workerProject = await createProject(app, "Worker");
  const managerProject = await createProject(app, "Manager");
  await grant(app, workerProject, "multi", "worker");
  await grant(app, managerProject, "multi", "manager");

  // Grantを全く持たないPrincipalは、activeRole付きではProject本文もDirection参照も得られない。
  for (const [name, args] of [
    ["get_project", { projectId: workerProject }],
    ["list_intents", { projectId: workerProject }],
  ] as const) {
    const denied = await callTool(app, name, args, "ungranted", "worker");
    assert.equal(errorCode(denied), "FORBIDDEN");
    assert.equal(denied.structuredContent.error.activeRole, "worker");
  }
  assert.deepEqual((await callTool(app, "list_projects", {}, "ungranted", "worker")).structuredContent.projects, []);

  // 他RoleのGrantは合算しない。activeRoleのGrantがあるProjectだけを読める。
  assert.equal(errorCode(await callTool(app, "get_project", { projectId: managerProject }, "multi", "worker")), "FORBIDDEN");
  assert.equal((await callTool(app, "get_project", { projectId: workerProject }, "multi", "worker")).isError, undefined);
  const listed = await callTool(app, "list_projects", {}, "multi", "worker");
  assert.deepEqual(listed.structuredContent.projects.map((project: { id: string }) => project.id), [workerProject]);

  // headerなしは従来どおり（trusted-localではGrantなしでも参照・全件一覧できる）。
  assert.equal((await callTool(app, "get_project", { projectId: workerProject }, "ungranted")).isError, undefined);
  assert.equal((await callTool(app, "list_projects", {}, "ungranted")).structuredContent.projects.length, 2);
  await database.destroy();
});

test("Runtime向けAPIもactiveRoleを受け付け、trusted-localのAgent名はactiveRoleのGrantだけで認可する", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "runner", "runtime", "worker");
  const fetchEvents = (activeRole?: string) =>
    send(app, "GET", `/api/projects/${projectId}/runtime-events`, undefined, agentHeaders("runner", activeRole));

  assert.equal((await fetchEvents()).status, 200);
  assert.equal((await fetchEvents("runtime")).status, 200);
  const denied = await fetchEvents("worker");
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { error: { activeRole: string } }).error.activeRole, "worker");
  assert.equal((await fetchEvents("unknown")).status, 400);
  await database.destroy();
});

test("CORSはMCP・Runtime向けAPIでX-Compass-Active-Role headerを許可する", async () => {
  const { database, app } = await setup();
  const response = await app.request("/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "http://example.test",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,x-compass-active-role",
    },
  });
  assert.match(response.headers.get("Access-Control-Allow-Headers") ?? "", /X-Compass-Active-Role/i);
  await database.destroy();
});
