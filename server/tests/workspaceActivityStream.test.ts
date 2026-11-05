import assert from "node:assert/strict";
import test from "node:test";
import type { Kysely } from "kysely";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import type { Database } from "../src/bootstrap/database/schema.ts";
import { addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * UI-L1: Workspace共通と配下全Projectの業務Activityを、原記録を複製せず横断して取得する。
 * コメント・Claimの更新・解放は業務Activityに混ぜず、別Workspaceは含めない。同時刻・再送・ページング中の追加でも順序と位置が安定する。
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

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

let sequence = 0;
const next = (label: string) => `${label}-${++sequence}`;

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
  for (const project of [a, b, c]) {
    await services.grantProjectRoleUseCase.execute(project.id, { principalId: "manager", role: "manager" });
    await services.grantProjectRoleUseCase.execute(project.id, { principalId: "worker", role: "worker" });
    await services.grantProjectRoleUseCase.execute(project.id, { principalId: "reviewer", role: "reviewer" });
  }
  await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "strategist-a", role: "strategist" });
  await services.grantWorkspaceRoleUseCase.execute(otherWorkspace.id, { principalId: "strategist-b", role: "strategist" });
  const viewer = await createTestHuman(database);
  const outsider = await createTestHuman(database);
  await addTestWorkspaceMembership(database, workspace.id, viewer, "viewer");
  await addTestWorkspaceMembership(database, otherWorkspace.id, outsider, "owner");
  return { services, app, workspace, otherWorkspace, a, b, c, viewer, outsider };
};

/** Taskを起票から受入まで進める。コメントとClaimの更新も行い、それらが業務Activityにならないことを確かめる素材にする。 */
const runTask = async (app: App, projectId: string, storyId: string, title: string, finish: "accept" | "reject") => {
  const task = ok(await callTool(app, "manager", "issue_task", { projectId, storyId, title, requestId: next("task") }, "manager"));
  const claim = ok(await callTool(app, "worker", "claim_task", { taskId: task.id, requestId: next("claim") }, "worker"));
  ok(await callTool(app, "worker", "renew_claim", { claimId: claim.claimId }, "worker"));
  ok(await callTool(app, "worker", "add_task_comment", { taskId: task.id, claimId: claim.claimId, body: "秘密のコメント本文", requestId: next("comment") }, "worker"));
  ok(await callTool(app, "worker", "complete_task", { taskId: task.id, claimId: claim.claimId, requestId: next("complete") }, "worker"));
  const review = ok(await callTool(app, "reviewer", "claim_review", { taskId: task.id, requestId: next("review") }, "reviewer"));
  ok(await callTool(app, "reviewer", "reviewed_task", { taskId: task.id, claimId: review.claimId, requestId: next("reviewed") }, "reviewer"));
  const acceptance = ok(await callTool(app, "manager", "claim_acceptance", { taskId: task.id, requestId: next("acceptance") }, "manager"));
  const tool = finish === "accept" ? "accept_task" : "reject_task";
  ok(await callTool(app, "manager", tool, {
    taskId: task.id, claimId: acceptance.claimId, requestId: next("finish"), ...(finish === "reject" ? { reason: "テスト不足" } : {}),
  }, "manager"));
  return task;
};

const stream = async (app: App, human: TestHuman, workspaceId: string, query = ""): Promise<Json> => {
  const response = await requestAs(app, human)(`/api/workspaces/${workspaceId}/activity-stream${query}`);
  assert.equal(response.status, 200, query);
  return (await response.json()) as Json;
};

test("Workspace共通と配下全Projectの業務Activityを漏れ・重複なく横断し、コメント・Claim更新と別Workspaceは含めない", async () => {
  const database = createDatabase(":memory:");
  try {
    const { services, app, workspace, otherWorkspace, a, b, c, viewer, outsider } = await setup(database);
    await services.createIntentUseCase.execute(workspace.id, { title: "認証を整える", desiredState: "sign inできる" });
    const storyA = ok(await callTool(app, "manager", "issue_story", { projectId: a.id, title: "Story A", requestId: next("story") }, "manager"));
    const storyB = ok(await callTool(app, "manager", "issue_story", { projectId: b.id, title: "Story B", requestId: next("story") }, "manager"));
    const storyC = ok(await callTool(app, "manager", "issue_story", { projectId: c.id, title: "Story C", requestId: next("story") }, "manager"));
    await runTask(app, a.id, storyA.id, "Task A1", "accept");
    await runTask(app, b.id, storyB.id, "Task B1", "reject");
    await runTask(app, c.id, storyC.id, "Task C1", "accept");
    ok(await callTool(app, "strategist-a", "record_workspace_activity", {
      workspaceId: workspace.id, type: "research.summary", summary: "調査した", requestId: next("note"),
    }, "strategist"));
    await services.createIntentUseCase.execute(otherWorkspace.id, { title: "別Workspaceの目標", desiredState: "x" });

    const all: Json[] = [];
    let before: string | null = null;
    let matched = 0;
    do {
      const page: Json = await stream(app, viewer, workspace.id, `?limit=4${before === null ? "" : `&before=${before}`}`);
      assert.ok(page.activities.length <= 4);
      all.push(...page.activities);
      matched = page.matchedCount;
      before = page.nextCursor;
    } while (before !== null);

    // 漏れ・重複なし: 同じ条件の全件と同じ集合・件数で、新しい順に並ぶ。
    assert.equal(all.length, matched);
    assert.equal(new Set(all.map((item) => item.id)).size, all.length);
    assert.deepEqual(all.map((item) => item.cursor), [...all.map((item) => item.cursor)].sort((x, y) => y - x));
    const types = all.map((item) => item.type).sort();
    assert.deepEqual(types, [
      "intent.created",
      "research.summary",
      "story.completed",
      "story.created", "story.created",
      "story.started", "story.started",
      "task.accepted",
      "task.created", "task.created",
      "task.completed", "task.completed",
      "task.rejected",
      "task.reviewed", "task.reviewed",
      "task.started", "task.started",
    ].sort());
    // Workspace共通とProject A・Bだけ。別Workspace（Project C・別の目標）は含めない。
    assert.deepEqual([...new Set(all.map((item) => item.projectId))].sort(), [null, a.id, b.id].sort());
    assert.ok(all.every((item) => item.workspaceId === workspace.id));
    assert.ok(all.every((item) => !JSON.stringify(item).includes("Story C") && !JSON.stringify(item).includes("別Workspaceの目標")));
    // コメント追加・Claimの更新・解放・Reviewer / 受入担当のClaimは業務Activityではない（本文の抜粋も含めない）。
    assert.ok(all.every((item) => !JSON.stringify(item).includes("秘密のコメント本文")));
    assert.equal(all.filter((item) => item.type === "task.started").length, 2);
    // 原記録の参照を保つ: 各Project Activityは同じidをProject scopeの一覧から引ける。
    const projectIds = new Set(
      ((await (await requestAs(app, viewer)(`/api/projects/${a.id}/activities?limit=100`)).json()) as Json).activities.map((item: Json) => item.id),
    );
    for (const item of all.filter((entry) => entry.projectId === a.id)) assert.ok(projectIds.has(item.id));

    // 対象・種別・検索・期間での絞り込み。
    const only = async (query: string) => (await stream(app, viewer, workspace.id, query)).activities.map((item: Json) => item.type);
    assert.deepEqual((await only(`?workspaceOnly=true&limit=100`)).sort(), ["intent.created", "research.summary"]);
    const projectB = await stream(app, viewer, workspace.id, `?projectId=${b.id}&limit=100`);
    assert.ok(projectB.activities.every((item: Json) => item.projectId === b.id));
    assert.equal(projectB.matchedCount, projectB.activities.length);
    assert.deepEqual(await only(`?type=task.rejected`), ["task.rejected"]);
    assert.deepEqual(await only(`?q=${encodeURIComponent("Task B1")}&limit=100`).then((list: string[]) => [...list].sort()), [
      "task.completed", "task.created", "task.rejected", "task.reviewed", "task.started",
    ]);
    assert.deepEqual(await only(`?q=${encodeURIComponent("テスト不足")}`), ["task.rejected"]); // 判断理由（body）
    assert.deepEqual(await only(`?q=${encodeURIComponent("100%_")}`), []); // LIKEの特殊文字はそのまま検索する
    assert.deepEqual(await only(`?q=strategist-a`), ["research.summary"]); // 主体
    const none = await stream(app, viewer, workspace.id, `?q=nothing-matches`);
    assert.deepEqual([none.activities, none.matchedCount, none.nextCursor], [[], 0, null]);
    const newest = all[0]!;
    const oldest = all.at(-1)!;
    assert.equal((await stream(app, viewer, workspace.id, `?from=${newest.occurredAt + 1}`)).matchedCount, 0);
    assert.equal((await stream(app, viewer, workspace.id, `?from=${oldest.occurredAt}&to=${newest.occurredAt}`)).matchedCount, all.length);
    // 他Workspaceのprojectを指定しても、その記録は返らない。
    assert.deepEqual((await stream(app, viewer, workspace.id, `?projectId=${c.id}`)).activities, []);

    // 権限: 別Workspaceのmemberは存在を区別せず404。形式外の位置・矛盾する条件は400。
    assert.equal((await requestAs(app, outsider)(`/api/workspaces/${workspace.id}/activity-stream`)).status, 404);
    assert.equal((await requestAs(app, viewer)(`/api/workspaces/${otherWorkspace.id}/activity-stream`)).status, 404);
    for (const bad of ["?before=abc", `?before=1.1&after=1.1`, `?projectId=${a.id}&workspaceOnly=true`, "?from=2&to=1", "?limit=0", "?type=Not%20A%20Type"]) {
      assert.equal((await requestAs(app, viewer)(`/api/workspaces/${workspace.id}/activity-stream${bad}`)).status, 400, bad);
    }
    // Agentの既存scope認可は広げない: 横断取得はMCP toolに存在しない。
    const tools = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer strategist-a", "X-Compass-Active-Role": "strategist" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
    });
    assert.equal((await tools.text()).includes("activity_stream"), false);
  } finally {
    await database.destroy();
  }
});

test("同時刻・再送・ページング中の追加でも位置と順序が安定し、訂正は原記録を保つ", async () => {
  const database = createDatabase(":memory:");
  try {
    const { app, workspace, a, viewer } = await setup(database);
    const at = 1_700_000_000_000;
    const record = (requestId: string, extra: object = {}) =>
      callTool(app, "manager", "record_activity", { projectId: a.id, type: "note.recorded", summary: requestId, occurredAt: at, requestId, ...extra }, "manager");
    const first = ok(await record("n-1"));
    for (const id of ["n-2", "n-3", "n-4", "n-5"]) ok(await record(id));
    ok(await callTool(app, "strategist-a", "record_workspace_activity", {
      workspaceId: workspace.id, type: "note.recorded", summary: "w-1", occurredAt: at, requestId: "w-1",
    }, "strategist"));
    // 再送は増えない。
    assert.equal(ok(await record("n-1")).created, false);

    const page1 = await stream(app, viewer, workspace.id, "?limit=2");
    assert.deepEqual(page1.activities.map((item: Json) => item.summary), ["w-1", "n-5"]);
    // ページ間に新しい記録（過去の時刻を含む）が追加されても、続きは重複も欠落もしない。
    ok(await record("n-6", { occurredAt: at + 10 }));
    ok(await record("n-0", { occurredAt: at - 10 }));
    const page2 = await stream(app, viewer, workspace.id, `?limit=2&before=${page1.nextCursor}`);
    const page3 = await stream(app, viewer, workspace.id, `?limit=2&before=${page2.nextCursor}`);
    const rest = await stream(app, viewer, workspace.id, `?limit=10&before=${page3.nextCursor}`);
    assert.deepEqual(
      [...page2.activities, ...page3.activities, ...rest.activities].map((item: Json) => item.summary),
      ["n-4", "n-3", "n-2", "n-1", "n-0"],
    );
    assert.equal(rest.nextCursor, null);
    // 同じ位置は何度取得しても同じ結果。
    assert.deepEqual(await stream(app, viewer, workspace.id, `?limit=2&before=${page1.nextCursor}`), page2);

    // 昇順の差分取得: 位置の後だけを、同時刻でもcursor順に返す。
    const forward = await stream(app, viewer, workspace.id, "?limit=100&after=0.0");
    assert.deepEqual(forward.activities.map((item: Json) => item.summary), ["n-0", "n-1", "n-2", "n-3", "n-4", "n-5", "w-1", "n-6"]);
    const tail = await stream(app, viewer, workspace.id, `?after=${forward.nextCursor}`);
    assert.deepEqual([tail.activities, tail.nextCursor], [[], forward.nextCursor]);
    ok(await record("n-7", { occurredAt: at + 20 }));
    assert.deepEqual((await stream(app, viewer, workspace.id, `?after=${forward.nextCursor}`)).activities.map((item: Json) => item.summary), ["n-7"]);

    // 訂正は追記で、原記録は書き換えず参照を保つ。
    const correction = ok(await record("n-1c", { summary: "n-1の訂正", correctsActivityId: first.activity.id }));
    const detail = await requestAs(app, viewer)(`/api/projects/${a.id}/activities/${first.activity.id}`);
    const body = (await detail.json()) as Json;
    assert.equal(body.activity.summary, "n-1");
    assert.deepEqual(body.corrections.map((item: Json) => item.id), [correction.activity.id]);
    const corrected = (await stream(app, viewer, workspace.id, "?limit=100")).activities.find((item: Json) => item.id === correction.activity.id);
    assert.equal(corrected.correctsActivityId, first.activity.id);
  } finally {
    await database.destroy();
  }
});
