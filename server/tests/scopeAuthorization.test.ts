import assert from "node:assert/strict";
import test from "node:test";
import { executionRoles, workspaceRoles, type HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, addTestWorkspaceMembership, createTestHuman, humanHeaders, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * S06-04: 公開済みの入口（Human Web API・MCP・Project Role Context・Runtime向けAPI）を横断して、
 * Principal + scope + activeRoleが一致する操作だけが成功することを検証する。
 * WorkspaceのRole（strategist / researcher / evaluator）とProjectのRole（manager / worker / reviewer）は互いに継承・合算せず、
 * Workspace MembershipだけではProjectのWorkへ入れない。
 */

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;
type ToolResult = { isError?: boolean; structuredContent: Json };

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });

let rpcId = 0;
const callTool = async (app: App, bearer: string, name: string, args: object, activeRole?: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};

const errorCode = (result: ToolResult) => (result.isError ? result.structuredContent.error.code : "OK");

/**
 * 新規DBに2つのWorkspace（A・B）と、それぞれのProjectを作る。Workspace AにはIntent・Outcome、Project AにはTaskを置く。
 * ownerはWorkspace / Projectの作成者としてowner Membershipを持つ。
 */
const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services);
  const remoteApp = createApp(services, { humanAuth: { mode: "remote", publicOrigin: "https://compass.example" } });
  const owner = await createTestHuman(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const otherWorkspace = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const project = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha app" });
  const otherProject = await services.human.createWorkspaceProject.execute(actorOf(owner), otherWorkspace.id, { name: "Beta app" });
  const intent = await services.createIntentUseCase.execute(workspace.id, { title: "Intent", desiredState: "done" });
  const outcome = await services.createOutcomeUseCase.execute(workspace.id, intent.id, {
    title: "Outcome",
    description: "D",
    rationale: "R",
    successCriteria: [{ description: "C", measurement: "M" }],
  });
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "planner", role: "manager" });
  const task = await services.taskCoordinationService.issueTask("planner", { projectId: project.id, title: "Task" }, "scope-task");
  return { database, services, app, remoteApp, owner, workspace, otherWorkspace, project, otherProject, intent, outcome, task };
};

test("MCPはactiveRoleとscopeが一致する入口だけを認可し、全Roleを持つPrincipalでもWorkspaceとProjectのGrantを合算しない", async () => {
  const { database, services, app, workspace, otherWorkspace, project, otherProject, intent, outcome, task } = await setup();
  try {
    // 同じPrincipalにWorkspace AのWorkspace Role全部と、Project AのProject Role全部を付与する。
    for (const role of workspaceRoles) await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "multi", role });
    for (const role of executionRoles) await services.grantProjectRoleUseCase.execute(project.id, { principalId: "multi", role });

    const projectReads = (role: string): [string, object][] => [
      ["get_project", { projectId: project.id }],
      ["list_tasks", { projectId: project.id }],
      ["list_stories", { projectId: project.id }],
      ["list_changes", { projectId: project.id }],
      ["list_task_comments", { taskId: task.id }],
      ["list_activities", { projectId: project.id }],
      ["get_role_context", { projectId: project.id, role }],
    ];
    const workspaceReads: [string, object][] = [
      ["list_intents", { workspaceId: workspace.id }],
      ["get_intent", { workspaceId: workspace.id, intentId: intent.id }],
      ["list_outcomes", { workspaceId: workspace.id, intentId: intent.id }],
      ["get_outcome", { workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id }],
      ["list_outcome_targets", { workspaceId: workspace.id, outcomeId: outcome.id }],
      ["list_outcome_target_work", { workspaceId: workspace.id, intentId: intent.id }],
      ["list_outcome_target_executions", { workspaceId: workspace.id, outcomeId: outcome.id }],
    ];

    for (const role of executionRoles) {
      for (const [name, args] of projectReads(role)) {
        assert.equal(errorCode(await callTool(app, "multi", name, args, role)), "OK", `${role} ${name}`);
        // 別ProjectにはGrantが無い（Task IDで指定するtoolは対象外）。
        if (!("projectId" in args)) continue;
        const other = { ...args, projectId: otherProject.id };
        assert.equal(errorCode(await callTool(app, "multi", name, other, role)), "FORBIDDEN", `${role} ${name} other`);
      }
      // Project RoleはWorkspace Directionの参照に使えない（Project GrantからWorkspaceへ継承しない）。
      for (const [name, args] of workspaceReads) {
        const denied = await callTool(app, "multi", name, args, role);
        assert.equal(errorCode(denied), "FORBIDDEN", `${role} ${name}`);
        assert.equal(JSON.stringify(denied).includes(outcome.title), false);
      }
    }

    for (const role of workspaceRoles) {
      for (const [name, args] of workspaceReads) {
        assert.equal(errorCode(await callTool(app, "multi", name, args, role)), "OK", `${role} ${name}`);
        const other = { ...args, workspaceId: otherWorkspace.id };
        assert.equal(errorCode(await callTool(app, "multi", name, other, role)), "FORBIDDEN", `${role} ${name} other`);
      }
      // Workspace RoleはProjectのWork・Project参照・Project Role Context・Project Activityに使えない。
      for (const [name, args] of projectReads(role)) {
        assert.equal(errorCode(await callTool(app, "multi", name, args, role)), "FORBIDDEN", `${role} ${name}`);
      }
      assert.deepEqual((await callTool(app, "multi", "list_projects", {}, role)).structuredContent.projects, []);
    }

    // Workspace Role専用のContextは要求Roleと同じactiveRoleだけが読める。
    const contexts: [string, string, object][] = [
      ["strategist", "get_strategist_context", { workspaceId: workspace.id }],
      ["researcher", "list_research_requests", { workspaceId: workspace.id }],
      ["evaluator", "get_evaluator_context", { workspaceId: workspace.id, outcomeId: outcome.id }],
    ];
    for (const [required, name, args] of contexts) {
      for (const role of [...workspaceRoles, ...executionRoles]) {
        const result = await callTool(app, "multi", name, args, role);
        assert.equal(errorCode(result), role === required ? "OK" : "FORBIDDEN", `${role} ${name}`);
      }
    }

    // Workspace Directionの状態変更もWorkspace RoleのactiveRoleに限る。Project RoleではTargetを変えられない。
    const target = { workspaceId: workspace.id, outcomeId: outcome.id, projectId: project.id };
    for (const role of [...executionRoles, "researcher", "evaluator"]) {
      assert.equal(errorCode(await callTool(app, "multi", "set_outcome_target", target, role)), "FORBIDDEN", role);
    }
    assert.deepEqual((await callTool(app, "multi", "list_outcome_targets", target, "strategist")).structuredContent.targets, []);
    assert.equal(errorCode(await callTool(app, "multi", "set_outcome_target", target, "strategist")), "OK");

    // Project Roleの状態変更もactiveRoleのRoleに限る。Workspace RoleのactiveRoleではTaskをclaimできない。
    for (const role of workspaceRoles) {
      assert.equal(errorCode(await callTool(app, "multi", "claim_task", { taskId: task.id, requestId: `claim-${role}` }, role)), "FORBIDDEN");
      assert.equal(
        errorCode(await callTool(app, "multi", "record_activity", { projectId: project.id, type: "note.recorded", summary: "s", requestId: `act-${role}` }, role)),
        "FORBIDDEN",
      );
    }
    assert.equal(errorCode(await callTool(app, "multi", "claim_task", { taskId: task.id, requestId: "claim-worker" }, "worker")), "OK");
  } finally {
    await database.destroy();
  }
});

test("Project GrantはWorkspace Roleを新規発行せず、残ったDirection RoleのProject GrantでもWorkとWorkspace Directionに入れない", async () => {
  const { database, services, app, workspace, project, task } = await setup();
  try {
    for (const role of workspaceRoles) {
      await assert.rejects(services.grantProjectRoleUseCase.execute(project.id, { principalId: "legacy", role }), { code: "VALIDATION_ERROR" });
      // 新規発行では作れない旧Project Direction Grantをfixtureとして置く（Workspace Grantは持たない）。
      await database.insertInto("project_grant").values({ project_id: project.id, principal_id: "legacy", role, created_at: 1 }).execute();
    }
    for (const role of [undefined, ...workspaceRoles]) {
      for (const [name, args] of [
        ["list_tasks", { projectId: project.id }],
        ["list_stories", { projectId: project.id }],
        ["list_changes", { projectId: project.id }],
        ["list_task_comments", { taskId: task.id }],
        ["claim_task", { taskId: task.id, requestId: `legacy-claim-${role}` }],
        ["list_intents", { workspaceId: workspace.id }],
        ["get_strategist_context", { workspaceId: workspace.id }],
      ] as const) {
        // headerなしtrusted-localのDirection参照はGrantを問わない互換（docs/implementation-status.md）。
        if (role === undefined && name === "list_intents") continue;
        assert.equal(errorCode(await callTool(app, "legacy", name, args, role)), "FORBIDDEN", `${role} ${name}`);
      }
    }
    // Project参照・Project Role Contextの旧Direction Grantによる読取は、OrchestratorがprojectIdでWorkspace Roleを起動する
    // 移行経路（S07-03〜04・S08-01で切替）のため、このTaskでは拒否しない。
  } finally {
    await database.destroy();
  }
});

test("remote modeのAgent Credentialは発行scopeのRoleだけで認可し、activeRoleとscopeの不一致を拒否する", async () => {
  const { database, services, app, remoteApp, owner, workspace, project, intent } = await setup();
  try {
    await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "strategist-a", role: "strategist" });
    await services.grantProjectRoleUseCase.execute(project.id, { principalId: "worker-a", role: "worker" });
    const issue = async (path: string, principalId: string) => {
      const response = await requestAs(app, owner)(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "agent", principalId }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return ((await response.json()) as { token: string }).token;
    };
    const strategist = await issue(`/api/workspaces/${workspace.id}/credentials`, "strategist-a");
    const worker = await issue(`/api/projects/${project.id}/credentials`, "worker-a");

    assert.equal(errorCode(await callTool(remoteApp, strategist, "get_strategist_context", { workspaceId: workspace.id }, "strategist")), "OK");
    assert.equal(errorCode(await callTool(remoteApp, strategist, "list_intents", { workspaceId: workspace.id })), "OK");
    for (const activeRole of [undefined, "strategist", "manager"]) {
      assert.equal(errorCode(await callTool(remoteApp, strategist, "list_tasks", { projectId: project.id }, activeRole)), "FORBIDDEN");
      assert.equal(errorCode(await callTool(remoteApp, strategist, "get_project", { projectId: project.id }, activeRole)), "FORBIDDEN");
    }
    assert.deepEqual((await callTool(remoteApp, strategist, "list_projects", {})).structuredContent.projects, []);
    assert.equal(errorCode(await callTool(remoteApp, strategist, "get_strategist_context", { workspaceId: workspace.id }, "manager")), "FORBIDDEN");

    assert.equal(errorCode(await callTool(remoteApp, worker, "list_tasks", { projectId: project.id }, "worker")), "OK");
    assert.equal(errorCode(await callTool(remoteApp, worker, "get_role_context", { projectId: project.id, role: "worker" }, "worker")), "OK");
    for (const activeRole of [undefined, "worker", "strategist"]) {
      const denied = await callTool(remoteApp, worker, "list_intents", { workspaceId: workspace.id }, activeRole);
      assert.equal(errorCode(denied), "FORBIDDEN");
      assert.equal(JSON.stringify(denied).includes(intent.id), false);
    }
    assert.equal(errorCode(await callTool(remoteApp, worker, "list_tasks", { projectId: project.id }, "strategist")), "FORBIDDEN");
    assert.equal(errorCode(await callTool(remoteApp, worker, "get_role_context", { projectId: project.id, role: "strategist" })), "FORBIDDEN");
  } finally {
    await database.destroy();
  }
});

test("Human Web APIはWorkspace MembershipとProject Membershipを継承せず、Workspace memberだけではProjectのTaskへ入れない", async () => {
  const { database, app, workspace, project, intent, task } = await setup();
  try {
    const workspaceOnly = await createTestHuman(database);
    const projectOnly = await createTestHuman(database);
    await addTestWorkspaceMembership(database, workspace.id, workspaceOnly, "owner");
    await addTestMembership(database, project.id, projectOnly, "owner");

    const projectPaths = [
      `/api/projects/${project.id}`,
      `/api/projects/${project.id}/execution`,
      `/api/projects/${project.id}/tasks/${task.id}`,
      `/api/projects/${project.id}/changes`,
      `/api/projects/${project.id}/activities`,
    ];
    const workspacePaths = [
      `/api/workspaces/${workspace.id}`,
      `/api/workspaces/${workspace.id}/intents`,
      `/api/workspaces/${workspace.id}/intents/${intent.id}`,
      `/api/workspaces/${workspace.id}/intents/${intent.id}/outcome-target-work`,
    ];

    for (const path of workspacePaths) assert.equal((await requestAs(app, workspaceOnly)(path)).status, 200, path);
    for (const path of projectPaths) assert.equal((await requestAs(app, workspaceOnly)(path)).status, 404, path);
    const createTask = await requestAs(app, workspaceOnly)(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Not allowed" }),
    });
    assert.equal(createTask.status, 404);

    for (const path of projectPaths) assert.equal((await requestAs(app, projectOnly)(path)).status, 200, path);
    for (const path of workspacePaths) assert.equal((await requestAs(app, projectOnly)(path)).status, 404, path);

    // Human SessionはMCPのAgent認可に使わず、Agent BearerはHuman向けWeb APIの認可に使わない。
    const sessionMcp = await app.request("/mcp", {
      method: "POST",
      headers: humanHeaders(projectOnly, { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "list_tasks", arguments: { projectId: project.id } } }),
    });
    const data = (await sessionMcp.text()).split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data);
    assert.equal(JSON.parse(data.slice(6)).result.isError, true);
    assert.equal((await app.request(`/api/projects/${project.id}/execution`, { headers: { Authorization: "Bearer planner" } })).status, 401);
  } finally {
    await database.destroy();
  }
});
