import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/presentation/http/createApp.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { addTestMembership, createSignedInApp, createTestHuman, requestAs } from "./support/humanSession.ts";

/**
 * 開発詳細（UI-W1）の検索・ページングWeb API。Story・TaskはMCP（Agent）で作り、HumanはMembershipで読む。
 * 検索・状態・Outcomeの絞り込みと、進捗の分母（絞り込みで変えない）、ページの境界をserverが決める。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

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

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = await createSignedInApp(database, services);
  const plain = createApp(services);
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "Many stories" });
  const intent = await services.createIntentUseCase.execute(project.workspaceId, { title: "Visible", desiredState: "Humans can follow Execution" });
  assert.equal((await app.request(`/api/projects/${project.id}/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId: "mgr", role: "manager" }) })).status, 201);
  assert.equal((await app.request(`/api/projects/${project.id}/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId: "wrk", role: "worker" }) })).status, 201);
  const outcome = await services.createOutcomeUseCase.execute(project.workspaceId, intent.id, {
    title: "Outcome", description: "Visible", intentVersion: 1, rationale: "Because", successCriteria: [{ description: "c1", measurement: "m1", target: null }],
  });
  await services.setOutcomeTargetProjectUseCase.execute(project.workspaceId, outcome.id, project.id);
  const second = await services.createOutcomeUseCase.execute(project.workspaceId, intent.id, {
    title: "Second outcome", description: "Visible", intentVersion: 1, rationale: "Because", successCriteria: [{ description: "c2", measurement: "m2", target: null }],
  });
  await services.setOutcomeTargetProjectUseCase.execute(project.workspaceId, second.id, project.id);
  const viewer = await createTestHuman(database);
  await addTestMembership(database, project.id, viewer, "viewer");
  const get = async (query = "") => {
    const response = await requestAs(plain, viewer)(`/api/projects/${project.id}/work${query}`);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { app, project, outcome, second, get, plain, viewer };
};

test("全Outcome・未設定・TaskなしのStory・Storyに属さないTaskを、サーバー側で検索・ページングし、進捗の分母を絞り込みで変えない", async () => {
  const kit = await setup();
  const { app, project, outcome } = kit;
  // Outcome由来のStory（Outcomeごとに1件、各2 Task）と、手動Story 12件（各2 Task）、Taskの無い手動Story、Storyに属さないTask 3件。
  const outcomeStories: string[] = [];
  for (const [index, owner] of [outcome, kit.second].entries()) {
    const story = await ok(callTool(app, "issue_story", { projectId: project.id, title: `Outcome story ${index + 1}`, description: `受入条件 ${index + 1}: 全文を読める`, outcomeId: owner.id, requestId: next("s") }, "mgr"));
    outcomeStories.push(story.id);
    for (const label of ["alpha", "beta"]) {
      await ok(callTool(app, "issue_task", { projectId: project.id, storyId: story.id, title: `${label} outcome task ${index + 1}`, taskKey: next("k"), requestId: next("t") }, "mgr"));
    }
  }
  const manualStories: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const manual = await ok(callTool(app, "issue_story", { projectId: project.id, title: `Manual story ${String(index).padStart(2, "0")}`, description: index === 3 ? "手動の受入条件\nSMARTな文章" : `手動 ${index}`, requestId: next("s") }, "mgr"));
    manualStories.push(manual.id);
    for (const label of ["alpha", "beta"]) {
      await ok(callTool(app, "issue_task", { projectId: project.id, storyId: manual.id, title: `${label} manual task ${index}`, requestId: next("t") }, "mgr"));
    }
  }
  await ok(callTool(app, "issue_story", { projectId: project.id, title: "Empty manual story", description: "Taskのない手動Story", requestId: next("s") }, "mgr"));
  for (let index = 1; index <= 3; index += 1) {
    await ok(callTool(app, "issue_task", { projectId: project.id, title: `Loose task ${index}`, requestId: next("t") }, "mgr"));
  }
  const looseId = (await kit.get("?view=tasks&q=Loose task 1")).body.items[0].task.id;
  assert.ok((await ok(callTool(app, "claim_task", { taskId: looseId, requestId: next("c") }, "wrk"))).claimId);

  // 全体: Story 15件（Outcome由来2 + 手動13）、Task 31件（4 + 24 + 3）。Story表示は10件ずつ、末尾にStoryに属さないTaskが続く。
  const first = await kit.get();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.scope, { stories: 15, tasks: 31, accepted: 0, canceled: 0 });
  assert.equal(first.body.pageSize, 10);
  assert.equal(first.body.range.total, 18);
  assert.equal(first.body.totalPages, 2);
  assert.equal(first.body.items.length, 10);
  assert.equal(first.body.items[0].story.title, "Outcome story 1");
  assert.equal(first.body.items[0].story.description, "受入条件 1: 全文を読める");
  assert.equal(first.body.items[0].tasks.length, 2);
  const second = await kit.get("?page=2");
  assert.deepEqual(second.body.items.map((item: any) => (item.kind === "story" ? item.story.title : item.task.title)), [
    "Manual story 09", "Manual story 10", "Manual story 11", "Manual story 12", "Empty manual story", "Loose task 1", "Loose task 2", "Loose task 3",
  ]);
  assert.deepEqual(second.body.range, { from: 11, to: 18, total: 18 });
  // Taskの無い手動Storyも対象になる。
  assert.equal(second.body.items[4].taskCount, 0);
  // 範囲外のページは最終ページへ寄せ、実際のページを返す。
  assert.equal((await kit.get("?page=99")).body.page, 2);

  // Task一覧は20件ずつ。StoryやOutcomeをまたぎ、所属Storyを添える。
  const tasks = await kit.get("?view=tasks");
  assert.equal(tasks.body.pageSize, 20);
  assert.equal(tasks.body.range.total, 31);
  assert.equal(tasks.body.items.length, 20);
  assert.equal(tasks.body.items[0].story.outcomeId, outcome.id);
  assert.equal((await kit.get("?view=tasks&page=2")).body.items.at(-1).story, null);

  // Outcomeの絞り込み: 指定=そのOutcomeのStoryだけ、none=手動Story・Taskなし・Storyに属さないTask。
  const byOutcome = await kit.get(`?outcome=${outcome.id}`);
  assert.deepEqual(byOutcome.body.scope, { stories: 1, tasks: 2, accepted: 0, canceled: 0 });
  assert.equal(byOutcome.body.range.total, 1);
  const none = await kit.get("?outcome=none&view=tasks");
  assert.deepEqual(none.body.scope, { stories: 13, tasks: 27, accepted: 0, canceled: 0 });
  assert.equal(none.body.range.total, 27);
  assert.equal((await kit.get("?outcome=none")).body.range.total, 16);

  // 検索: 受入条件（Storyの説明）にも当たり、空白区切りはAND。件数と進捗の分母は別。
  const bySearch = await kit.get("?q=SMART");
  assert.equal(bySearch.body.matched.stories, 1);
  assert.equal(bySearch.body.matched.tasks, 2);
  assert.equal(bySearch.body.items[0].story.title, "Manual story 03");
  assert.deepEqual(bySearch.body.scope, first.body.scope);
  assert.equal((await kit.get("?q=beta manual task 7")).body.matched.tasks, 1);
  assert.equal((await kit.get("?q=beta nomatch")).body.range.total, 0);
  // Taskのない手動Storyも検索できる。状態で絞ったときはTaskを持つStoryだけ。
  assert.equal((await kit.get("?q=Taskのない")).body.items[0].story.title, "Empty manual story");
  assert.equal((await kit.get("?status=todo&q=Taskのない")).body.range.total, 0);
  // Storyを1件に絞る。
  const one = await kit.get(`?storyId=${manualStories[4]}`);
  assert.equal(one.body.range.total, 1);
  assert.deepEqual(one.body.scope, { stories: 1, tasks: 2, accepted: 0, canceled: 0 });

  // 状態: 作業中は取得済みのTaskだけ。Humanの判断待ちはClaim無しのレビュー・受入待ち。
  const doing = await kit.get("?view=tasks&status=doing");
  assert.equal(doing.body.range.total, 1);
  assert.equal(doing.body.items[0].task.title, "Loose task 1");
  assert.equal(doing.body.scope.tasks, 31);
  assert.equal((await kit.get("?status=awaiting_human")).body.range.total, 0);

  // 不正な条件は400。
  assert.equal((await kit.get("?view=x")).status, 400);
  assert.equal((await kit.get("?status=nope")).status, 400);
  assert.equal((await kit.get("?page=0")).status, 400);
  assert.equal((await kit.get(`?q=${"a".repeat(201)}`)).status, 400);
});

test("Taskが無いProjectは0件の範囲を返し、存在しないProjectは404にする", async () => {
  const kit = await setup();
  const empty = await kit.get();
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.scope, { stories: 0, tasks: 0, accepted: 0, canceled: 0 });
  assert.equal(empty.body.range.total, 0);
  assert.equal(empty.body.totalPages, 1);
  assert.deepEqual(empty.body.items, []);
  const missing = await requestAs(kit.plain, kit.viewer)("/api/projects/00000000-0000-4000-8000-000000000000/work");
  assert.equal(missing.status, 404);
});
