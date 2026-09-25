import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { addTestMembership, createSignedInApp, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * Human向けのExecution閲覧Web API（Task 45）。Story・Task・Claim・Comment・ChangeはMCP（Agent）で作り、
 * HumanはSession・Membershipで読むだけ。Human介入（受入・差戻し等）は`executionOperator.test.ts`（Task 46）、手動起票はTask 47の範囲。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  // `app`はorphan Projectの補完付きのテスト用Human。Membershipごとの検査は、Sessionを差し替えない`plain`で行う。
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

/** Outcome由来のStory（Task 2件: 差戻し済み・Claim中）と、Outcome無しの手動Story（Task 1件）を作る。 */
const seed = async (kit: Kit, name = "Compass") => {
  const { services, app } = kit;
  const project = await services.createProjectUseCase.execute({ name, mission: "Keep execution visible" });
  const intent = await services.createIntentUseCase.execute(project.id, { title: "Visible", desiredState: "Humans can follow Execution" });
  for (const [principalId, role] of [["mgr", "manager"], ["wrk", "worker"], ["rev", "reviewer"], ["ev", "evaluator"], ["str", "strategist"]] as const) {
    assert.equal((await app.request(`/api/projects/${project.id}/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId, role }) })).status, 201);
  }
  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, {
    title: "Outcome", description: "Visible", rationale: "Because",
    successCriteria: [{ description: "c1", measurement: "m1", target: null }],
  });
  const story = await ok(callTool(app, "issue_story", { projectId: project.id, title: "Outcome story", outcomeId: outcome.id, requestId: next("s") }, "mgr"));
  const rejected = await ok(callTool(app, "issue_task", { projectId: project.id, storyId: story.id, title: "Rejected task", description: "Do it", taskKey: next("k"), requestId: next("t") }, "mgr"));
  const work = await ok(callTool(app, "claim_task", { taskId: rejected.id, requestId: next("c") }, "wrk"));
  await ok(callTool(app, "add_task_comment", { taskId: rejected.id, claimId: work.claimId, body: "implemented", requestId: next("m") }, "wrk"));
  await ok(callTool(app, "complete_task", { taskId: rejected.id, claimId: work.claimId, requestId: next("d") }, "wrk"));
  const review = await ok(callTool(app, "claim_review", { taskId: rejected.id, requestId: next("r") }, "rev"));
  await ok(callTool(app, "reject_task", { taskId: rejected.id, claimId: review.claimId, reason: "tests missing", requestId: next("x") }, "rev"));
  const doing = await ok(callTool(app, "issue_task", { projectId: project.id, storyId: story.id, title: "Doing task", taskKey: next("k"), requestId: next("t") }, "mgr"));
  const claim = await ok(callTool(app, "claim_task", { taskId: doing.id, requestId: next("c") }, "wrk"));
  const manual = await ok(callTool(app, "issue_story", { projectId: project.id, title: "Manual story", requestId: next("s") }, "mgr"));
  const manualTask = await ok(callTool(app, "issue_task", { projectId: project.id, storyId: manual.id, title: "Manual task", requestId: next("t") }, "mgr"));
  return { project, intent, outcome, story, manual, rejected, doing, claim, manualTask };
};

const json = async (response: Response) => {
  const body = await response.json();
  return body as Record<string, any>;
};

test("viewerがProjectのStory・Taskを状態・Claim・更新時刻付きで一覧し、outcomeIdで絞り込める", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const viewer = await createTestHuman(kit.database);
  await addTestMembership(kit.database, seeded.project.id, viewer, "viewer");
  const asViewer = requestAs(kit.plain, viewer);

  const response = await asViewer(`/api/projects/${seeded.project.id}/execution`);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.deepEqual(body.stories.map((story: any) => story.title), ["Outcome story", "Manual story"]);
  assert.equal(body.stories[0].outcomeId, seeded.outcome.id);
  assert.equal(body.stories[0].correlationId, `outcome:${seeded.outcome.id}`);
  assert.equal(body.stories[1].outcomeId, null);
  const byTitle = new Map(body.tasks.map((task: any) => [task.title, task]));
  const rejected = byTitle.get("Rejected task") as any;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectReason, "tests missing");
  assert.equal(rejected.activeClaim, null);
  const doing = byTitle.get("Doing task") as any;
  assert.equal(doing.status, "doing");
  assert.equal(doing.activeClaim.principalId, "wrk");
  assert.equal(doing.activeClaim.expiresAt, seeded.claim.expiresAt);
  assert.equal(typeof doing.updatedAt, "number");
  assert.equal(body.summary.total, 3);
  assert.equal(body.summary.byStatus.todo, 1);

  const filtered = await json(await asViewer(`/api/projects/${seeded.project.id}/execution?outcomeId=${seeded.outcome.id}`));
  assert.deepEqual(filtered.stories.map((story: any) => story.id), [seeded.story.id]);
  assert.deepEqual(filtered.tasks.map((task: any) => task.title).sort(), ["Doing task", "Rejected task"]);
});

test("Task詳細は説明・状態・Claim・Comment・差戻し理由・関連Changeを返し、別ProjectのTask IDは404", async () => {
  const kit = await setup();
  const alpha = await seed(kit, "Alpha");
  const beta = await seed(kit, "Beta");

  const detail = await json(await kit.app.request(`/api/projects/${alpha.project.id}/tasks/${alpha.rejected.id}`));
  assert.equal(detail.task.description, "Do it");
  assert.equal(detail.task.rejectReason, "tests missing");
  assert.equal(detail.story.id, alpha.story.id);
  assert.deepEqual(detail.comments.map((comment: any) => [comment.body, comment.principalId]), [["implemented", "wrk"]]);
  assert.deepEqual(detail.changes.map((change: any) => change.type), ["TASK_CREATED", "TASK_CLAIMED", "TASK_COMPLETED", "TASK_CLAIMED", "TASK_REJECTED"]);
  assert.ok(detail.changes.every((change: any) => change.entityId === alpha.rejected.id && change.correlationId === `outcome:${alpha.outcome.id}`));

  const claimed = await json(await kit.app.request(`/api/projects/${alpha.project.id}/tasks/${alpha.doing.id}`));
  assert.equal(claimed.task.activeClaim.claimId, alpha.claim.claimId);

  for (const path of [
    `/api/projects/${alpha.project.id}/tasks/${beta.rejected.id}`,
    `/api/projects/${alpha.project.id}/tasks/missing`,
  ]) {
    const response = await kit.app.request(path);
    assert.equal(response.status, 404, path);
    assert.equal((await json(response)).error.code, "NOT_FOUND");
  }
});

test("最近の変更は新しい順にcursorで古い変更を辿れ、不正なcursorは400", async () => {
  const kit = await setup();
  const alpha = await seed(kit, "Alpha");
  await seed(kit, "Beta");
  const base = `/api/projects/${alpha.project.id}/changes`;
  const all = await json(await kit.app.request(`${base}?limit=100`));
  assert.equal(all.nextCursor, null);
  const cursors = all.changes.map((change: any) => change.cursor);
  assert.deepEqual(cursors, [...cursors].sort((a: number, b: number) => b - a));
  assert.ok(all.changes.every((change: any) => change.projectId === alpha.project.id));

  const first = await json(await kit.app.request(`${base}?limit=3`));
  assert.deepEqual(first.changes.map((change: any) => change.cursor), cursors.slice(0, 3));
  assert.equal(first.nextCursor, cursors[2]);
  const second = await json(await kit.app.request(`${base}?limit=3&beforeCursor=${first.nextCursor}`));
  assert.deepEqual(second.changes.map((change: any) => change.cursor), cursors.slice(3, 6));

  // MCP list_changesと同じChange Log（同じcursor集合）。
  const mcp = await ok(callTool(kit.app, "list_changes", { projectId: alpha.project.id, afterCursor: 0 }, "mgr"));
  assert.deepEqual(mcp.changes.map((change: any) => change.cursor).reverse(), cursors);

  for (const query of ["?beforeCursor=0", "?beforeCursor=abc", "?limit=0", "?limit=101", "?limit="]) {
    const response = await kit.app.request(`${base}${query}`);
    assert.equal(response.status, 400, query);
    assert.equal((await json(response)).error.code, "VALIDATION_ERROR");
  }
});

test("OutcomeのEvaluation履歴を返し、別ProjectのOutcomeは404", async () => {
  const kit = await setup();
  const alpha = await seed(kit, "Alpha");
  const beta = await seed(kit, "Beta");
  const base = `/api/projects/${alpha.project.id}/outcomes`;
  assert.deepEqual((await json(await kit.app.request(`${base}/${alpha.outcome.id}/evaluations`))).evaluations, []);
  assert.equal((await kit.app.request(`${base}/${beta.outcome.id}/evaluations`)).status, 404);
});

test("未所属は404、viewer以上は参照可、archived Projectも参照だけでき、閲覧APIは書込を受け付けない", async () => {
  const kit = await setup();
  const seeded = await seed(kit);
  const projectId = seeded.project.id;
  const paths = [
    `/api/projects/${projectId}/execution`,
    `/api/projects/${projectId}/tasks/${seeded.rejected.id}`,
    `/api/projects/${projectId}/changes`,
    `/api/projects/${projectId}/outcomes/${seeded.outcome.id}/evaluations`,
  ];
  const outsider = await createTestHuman(kit.database);
  const members: Record<string, TestHuman> = {};
  for (const role of ["administrator", "editor", "viewer"] as const) {
    members[role] = await createTestHuman(kit.database);
    await addTestMembership(kit.database, projectId, members[role]!, role);
  }
  for (const path of paths) {
    assert.equal((await requestAs(kit.plain, outsider)(path)).status, 404, path);
    for (const [role, human] of Object.entries(members)) assert.equal((await requestAs(kit.plain, human)(path)).status, 200, `${role} ${path}`);
  }
  assert.equal((await kit.app.request(`/api/projects/${projectId}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "done" }) })).status, 200);
  for (const path of paths) assert.equal((await requestAs(kit.plain, members.viewer!)(path)).status, 200, `archived ${path}`);
  for (const path of paths) {
    assert.equal((await kit.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404, `POST ${path}`);
  }
  // Session無しは401。
  for (const path of paths) assert.equal((await kit.plain.request(path)).status, 401, path);
});
