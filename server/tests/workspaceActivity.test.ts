import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import type { Database } from "../src/bootstrap/database/schema.ts";
import { addTestMembership, addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * S07-02: canonical ActivityとProject Resource参照をscope別に接続する。
 * WorkspaceのResearch / DecisionはWorkspace Activity、ProjectのWork変更はProject Activityとして記録され、
 * Workspace履歴はWorkspace Role Grant（Human: Workspace Membership）、Project履歴はProject Role Grant（Project Membership）で別々に読める。
 * 明示記録の成果物はRepository / Docs（Project Resource + path + revision）を参照し、runId・本文の複製・Change Logを混ぜない。
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

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

/**
 * 新規DBに、Resourceを持つProject A・B（Workspace W）とProject C（別Workspace）を作り、
 * W・CのWorkspace Role Grant、AのProject Role Grantを付与する。
 */
const setup = async (database: Kysely<Database>) => {
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services);
  const owner = await createTestHuman(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const otherWorkspace = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const projectInput = (name: string) => ({
    name,
    repositories: [{ name: "repo", url: `https://example.com/${name}.git` }],
    resources: [{ name: "docs", url: `https://example.com/${name}/docs`, kind: "docs" }],
  });
  const a = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, projectInput("a"));
  const b = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, projectInput("b"));
  const c = await services.human.createWorkspaceProject.execute(actorOf(owner), otherWorkspace.id, projectInput("c"));
  await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "strategist-a", role: "strategist" });
  await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "researcher-a", role: "researcher" });
  await services.grantWorkspaceRoleUseCase.execute(otherWorkspace.id, { principalId: "strategist-b", role: "strategist" });
  await services.grantProjectRoleUseCase.execute(a.id, { principalId: "manager-a", role: "manager" });
  await services.grantProjectRoleUseCase.execute(a.id, { principalId: "worker-a", role: "worker" });
  return { services, app, owner, workspace, otherWorkspace, a, b, c };
};

test("Workspace / Project Activityはscope別に記録され、Workspace GrantとProject Grantで別々に読める", async () => {
  const database = createDatabase(":memory:");
  try {
    const { services, app, workspace, otherWorkspace, a, b, c } = await setup(database);
    const intent = await services.createIntentUseCase.execute(workspace.id, { title: "認証を整える", desiredState: "sign inできる" });

    // WorkspaceのDecision（追加Researchを含む）はWorkspace Activity。runRefはDirectionの来歴で、Activityには入らない。
    const decision = ok(await callTool(app, "strategist-a", "create_direction_decision", {
      workspaceId: workspace.id,
      intentId: intent.id,
      type: "additional_research",
      judgment: "IdPを調べる",
      reason: "選択肢が不足",
      research: { question: "どのIdPか", scope: "OIDC", completionCondition: "比較表", budgetTotal: 10 },
      requestKey: "decision-1",
      runRef: "run-should-not-leak",
    }, "strategist"));

    // ProjectのWork変更はProject Activity。
    const story = ok(await callTool(app, "manager-a", "issue_story", { projectId: a.id, title: "OIDCを入れる", requestId: "story-1" }, "manager"));

    // Workspace Roleの明示記録。成果物は所属ProjectのResource + path + revisionで参照し、本文を複製しない。
    const recordInput = {
      workspaceId: workspace.id,
      type: "research.summary",
      summary: "IdP候補を比較した",
      body: "比較表はProject Bのdocsを参照",
      refs: [
        { kind: "project_resource", resourceId: b.resources[0]!.id, path: "docs/idp.md", revision: "abc123" },
        { kind: "project_resource", resourceId: a.repositories[0]!.id },
        { kind: "research_request", id: decision.researchRequest.id },
      ],
      requestId: "ws-note-1",
    };
    const recorded = ok(await callTool(app, "researcher-a", "record_workspace_activity", recordInput, "researcher"));
    assert.equal(recorded.created, true);
    assert.equal(recorded.activity.scope, "workspace");
    assert.equal(recorded.activity.workspaceId, workspace.id);
    assert.equal(recorded.activity.projectId, null);
    assert.equal(recorded.activity.principalId, "researcher-a");
    assert.equal(recorded.activity.role, "researcher");
    assert.equal(recorded.activity.source, "recorded");
    // 再送は同じActivity、同じrequestIdの別内容はCONFLICT。
    const replay = ok(await callTool(app, "researcher-a", "record_workspace_activity", recordInput, "researcher"));
    assert.deepEqual([replay.created, replay.activity.id], [false, recorded.activity.id]);
    assert.equal(
      errorCode(await callTool(app, "researcher-a", "record_workspace_activity", { ...recordInput, summary: "別内容" }, "researcher")),
      "CONFLICT",
    );

    // Workspace履歴はWorkspace Role Grantで読む。DirectionのcanonicalとWorkspaceの明示記録だけで、Project Activityを含まない。
    const workspacePage = ok(await callTool(app, "strategist-a", "list_workspace_activities", { workspaceId: workspace.id, afterCursor: 0 }));
    assert.deepEqual(
      workspacePage.activities.map((item: Json) => [item.type, item.scope, item.projectId, item.source]),
      [
        ["intent.created", "workspace", null, "canonical"],
        ["decision.recorded", "workspace", null, "canonical"],
        ["research.requested", "workspace", null, "canonical"],
        ["research.summary", "workspace", null, "recorded"],
      ],
    );
    assert.equal(workspacePage.activities[3].hasBody, true);
    assert.equal("body" in workspacePage.activities[3], false);
    assert.equal(JSON.stringify(workspacePage).includes("run-should-not-leak"), false, "runRefをActivityに入れない");
    assert.ok(workspacePage.activities.every((item: Json) => !("runId" in item) && !("runRef" in item)));
    const byResource = ok(await callTool(app, "researcher-a", "list_workspace_activities", {
      workspaceId: workspace.id, refKind: "project_resource", refId: b.resources[0]!.id,
    }));
    assert.deepEqual(byResource.activities.map((item: Json) => item.id), [recorded.activity.id]);
    const detail = ok(await callTool(app, "strategist-a", "get_workspace_activity", { workspaceId: workspace.id, activityId: recorded.activity.id }));
    assert.equal(detail.activity.body, "比較表はProject Bのdocsを参照");
    assert.deepEqual(detail.activity.refs[0], { kind: "project_resource", resourceId: b.resources[0]!.id, path: "docs/idp.md", revision: "abc123" });

    // Project履歴はProject Role Grantで読む。Workspace Activityを含まず、Change LogのClaim等も混ぜない。
    ok(await callTool(app, "manager-a", "issue_task", { projectId: a.id, storyId: story.id, title: "実装", requestId: "task-1" }, "manager"));
    const tasks = ok(await callTool(app, "worker-a", "list_tasks", { projectId: a.id }, "worker"));
    ok(await callTool(app, "worker-a", "claim_task", { taskId: tasks.tasks[0].id, requestId: "claim-1" }, "worker"));
    const projectPage = ok(await callTool(app, "worker-a", "list_activities", { projectId: a.id, afterCursor: 0 }, "worker"));
    assert.deepEqual(projectPage.activities.map((item: Json) => [item.type, item.scope, item.workspaceId, item.projectId]), [
      ["story.created", "project", workspace.id, a.id],
      ["task.created", "project", workspace.id, a.id],
    ]);
    const changes = ok(await callTool(app, "worker-a", "list_changes", { projectId: a.id }, "worker"));
    assert.ok(changes.changes.some((change: Json) => change.type === "TASK_CLAIMED"));
    const projectActivityId = projectPage.activities[0].id;

    // scopeを越えた取得は存在しない扱い。
    assert.equal(errorCode(await callTool(app, "strategist-a", "get_workspace_activity", { workspaceId: workspace.id, activityId: projectActivityId })), "NOT_FOUND");
    assert.equal(errorCode(await callTool(app, "worker-a", "get_activity", { projectId: a.id, activityId: recorded.activity.id }, "worker")), "NOT_FOUND");
    assert.equal(errorCode(await callTool(app, "strategist-b", "get_workspace_activity", { workspaceId: otherWorkspace.id, activityId: recorded.activity.id })), "NOT_FOUND");

    // GrantはWorkspaceとProjectで継承しない。別Workspace・Project Role・activeRoleの不一致は拒否する。
    for (const [bearer, role] of [["worker-a", "worker"], ["manager-a", undefined], ["strategist-b", "strategist"]] as const) {
      const denied = await callTool(app, bearer, "list_workspace_activities", { workspaceId: workspace.id }, role);
      assert.equal(errorCode(denied), "FORBIDDEN", bearer);
      assert.equal(JSON.stringify(denied).includes("IdP候補"), false);
      assert.equal(errorCode(await callTool(app, bearer, "get_workspace_activity", { workspaceId: workspace.id, activityId: recorded.activity.id }, role)), "FORBIDDEN");
    }
    assert.equal(errorCode(await callTool(app, "strategist-a", "list_workspace_activities", { workspaceId: workspace.id }, "researcher")), "FORBIDDEN");
    assert.equal(errorCode(await callTool(app, "strategist-a", "list_activities", { projectId: a.id }, "strategist")), "FORBIDDEN");

    // 記録はWorkspace RoleのGrantだけ。Project Role・別Workspace・Roleを決められない呼出しは拒否する。
    const note = (requestId: string, extra: object = {}) => ({ workspaceId: workspace.id, type: "note.recorded", summary: "s", requestId, ...extra });
    assert.equal(errorCode(await callTool(app, "worker-a", "record_workspace_activity", note("w-1"), "worker")), "FORBIDDEN");
    assert.equal(errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-2", { role: "manager" }))), "FORBIDDEN");
    assert.equal(errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-3", { role: "researcher" }))), "FORBIDDEN");
    assert.equal(errorCode(await callTool(app, "strategist-b", "record_workspace_activity", note("w-4"), "strategist")), "FORBIDDEN");
    assert.equal(errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-5"))), "VALIDATION_ERROR");
    // Project ActivityのtoolでWorkspaceを指定することもできない（scopeの取り違えを黙って受け付けない）。
    assert.equal(errorCode(await callTool(app, "worker-a", "record_activity", { ...note("w-6"), projectId: a.id }, "worker")), "VALIDATION_ERROR");
    assert.equal(errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-6b", { projectId: a.id }), "strategist")), "VALIDATION_ERROR");

    // runId・本文の取り違え・別WorkspaceのResource・Project Activityの訂正は拒否する。
    assert.equal(errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-7", { runId: "run-1" }), "strategist")), "VALIDATION_ERROR");
    assert.equal(
      errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-8", { refs: [{ kind: "url", url: "https://e.com", content: "x" }] }), "strategist")),
      "VALIDATION_ERROR",
    );
    const foreign = await callTool(app, "strategist-a", "record_workspace_activity",
      note("w-9", { refs: [{ kind: "project_resource", resourceId: c.resources[0]!.id }] }), "strategist");
    assert.equal(errorCode(foreign), "VALIDATION_ERROR");
    assert.match(JSON.stringify(foreign.structuredContent.error), /refs.0.resourceId/);
    assert.equal(
      errorCode(await callTool(app, "strategist-a", "record_workspace_activity", note("w-10", { correctsActivityId: projectActivityId }), "strategist")),
      "NOT_FOUND",
    );

    // 訂正はWorkspace Activityを追記し、元は書き換えない。
    const correction = ok(await callTool(app, "strategist-a", "record_workspace_activity",
      note("w-11", { summary: "比較の対象を訂正", correctsActivityId: recorded.activity.id }), "strategist"));
    const corrected = ok(await callTool(app, "researcher-a", "get_workspace_activity", { workspaceId: workspace.id, activityId: recorded.activity.id }));
    assert.equal(corrected.activity.summary, "IdP候補を比較した");
    assert.deepEqual(corrected.corrections.map((item: Json) => item.id), [correction.activity.id]);

    assert.equal(errorCode(await callTool(app, "strategist-a", "list_workspace_activities", { workspaceId: "missing" })), "FORBIDDEN");
  } finally {
    await database.destroy();
  }
});

test("HumanはWorkspace MembershipでWorkspace Activity、Project MembershipでProject Activityを読み、互いに継承しない", async () => {
  const database = createDatabase(":memory:");
  try {
    const { app, workspace, a } = await setup(database);
    ok(await callTool(app, "manager-a", "issue_story", { projectId: a.id, title: "Story", requestId: "story-1" }, "manager"));
    const recorded = ok(await callTool(app, "strategist-a", "record_workspace_activity", {
      workspaceId: workspace.id,
      type: "decision.rationale",
      summary: "方針の理由",
      body: "詳細",
      refs: [{ kind: "project_resource", resourceId: a.resources[0]!.id, path: "adr/0001.md", revision: "def456" }],
      requestId: "rationale-1",
    }, "strategist"));

    const workspaceViewer = await createTestHuman(database);
    const projectViewer = await createTestHuman(database);
    await addTestWorkspaceMembership(database, workspace.id, workspaceViewer, "viewer");
    await addTestMembership(database, a.id, projectViewer, "viewer");

    const list = await requestAs(app, workspaceViewer)(`/api/workspaces/${workspace.id}/activities`);
    assert.equal(list.status, 200);
    const page = (await list.json()) as Json;
    assert.deepEqual(page.activities.map((item: Json) => [item.type, item.scope]), [["decision.rationale", "workspace"]]);
    assert.equal(page.activities[0].hasBody, true);
    const detail = await requestAs(app, workspaceViewer)(`/api/workspaces/${workspace.id}/activities/${recorded.activity.id}`);
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as Json;
    assert.equal(body.activity.body, "詳細");
    assert.deepEqual(body.activity.refs, [{ kind: "project_resource", resourceId: a.resources[0]!.id, path: "adr/0001.md", revision: "def456" }]);

    // Workspace MembershipだけではProject Activityを読めず、Project MembershipだけではWorkspace Activityを読めない。
    assert.equal((await requestAs(app, workspaceViewer)(`/api/projects/${a.id}/activities`)).status, 404);
    assert.equal((await requestAs(app, projectViewer)(`/api/workspaces/${workspace.id}/activities`)).status, 404);
    assert.equal((await requestAs(app, projectViewer)(`/api/workspaces/${workspace.id}/activities/${recorded.activity.id}`)).status, 404);
    const projectPage = (await (await requestAs(app, projectViewer)(`/api/projects/${a.id}/activities`)).json()) as Json;
    assert.deepEqual(projectPage.activities.map((item: Json) => item.type), ["story.created"]);
    assert.equal((await requestAs(app, projectViewer)(`/api/projects/${a.id}/activities/${recorded.activity.id}`)).status, 404);
    // Web UIの入口からは記録しない。
    const post = await requestAs(app, workspaceViewer)(`/api/workspaces/${workspace.id}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note", summary: "s" }),
    });
    assert.equal(post.status, 404);
  } finally {
    await database.destroy();
  }
});

test("archivedのWorkspaceは新しい記録を拒否し、保存済みの再送と参照は続けられる", async () => {
  const database = createDatabase(":memory:");
  try {
    const { services, app, owner, workspace } = await setup(database);
    const input = { workspaceId: workspace.id, type: "note.recorded", summary: "記録", requestId: "before-archive" };
    const saved = ok(await callTool(app, "strategist-a", "record_workspace_activity", input, "strategist"));
    await services.human.archiveWorkspace.execute(actorOf(owner), workspace.id, { reason: "終了" });

    const rejected = await callTool(app, "strategist-a", "record_workspace_activity", { ...input, requestId: "after-archive" }, "strategist");
    assert.equal(errorCode(rejected), "CONFLICT");
    const replay = ok(await callTool(app, "strategist-a", "record_workspace_activity", input, "strategist"));
    assert.deepEqual([replay.created, replay.activity.id], [false, saved.activity.id]);
    const page = ok(await callTool(app, "strategist-a", "list_workspace_activities", { workspaceId: workspace.id }));
    assert.deepEqual(page.activities.map((item: Json) => item.id), [saved.activity.id]);
  } finally {
    await database.destroy();
  }
});

test("新規file DBのWorkspace Activityは同じschemaで再起動後も公開入口から同じ内容で読める", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-activity-"));
  const path = join(directory, "compass.db");
  let database = createDatabase(path);
  try {
    const { app, workspace, a } = await setup(database);
    ok(await callTool(app, "researcher-a", "record_workspace_activity", {
      workspaceId: workspace.id,
      type: "research.summary",
      summary: "調査結果",
      refs: [{ kind: "project_resource", resourceId: a.resources[0]!.id, path: "research.md", revision: "r1" }],
      requestId: "persist-1",
    }, "researcher"));
    const before = ok(await callTool(app, "researcher-a", "list_workspace_activities", { workspaceId: workspace.id }));
    await database.destroy();

    database = createDatabase(path);
    await initializeSchema(database);
    const restarted = createApp(createApplicationServices(database));
    const after = ok(await callTool(restarted, "researcher-a", "list_workspace_activities", { workspaceId: workspace.id }));
    assert.deepEqual(after, before);
    const replay = ok(await callTool(restarted, "researcher-a", "record_workspace_activity", {
      workspaceId: workspace.id,
      type: "research.summary",
      summary: "調査結果",
      refs: [{ kind: "project_resource", resourceId: a.resources[0]!.id, path: "research.md", revision: "r1" }],
      requestId: "persist-1",
    }, "researcher"));
    assert.equal(replay.created, false);
  } finally {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
