import assert from "node:assert/strict";
import test from "node:test";
import {
  GetWorkspaceOutcomeOverviewUseCase,
  ListWorkspaceOutcomesUseCase,
  summarizeTaskProgress,
  type OutcomeProblemFact,
  type OutcomeDeliveryPort,
  type OutcomeProblemPort,
} from "@compass/direction";
import { CreateWorkspaceProjectUseCase, CreateWorkspaceUseCase, SQLiteProjectRepository, SQLiteWorkspaceRepository } from "@compass/organization";
import { createApp } from "../src/presentation/http/createApp.ts";
import { asOrganizationDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { projectRepositoryReferenceFinder } from "../src/infrastructure/repository/contextAdapters.ts";
import { createSignedInApp, seedWorkspaceGrant } from "./support/humanSession.ts";

type Database = ReturnType<typeof createDatabase>;
type App = ReturnType<typeof createApp>;

const counts = (overrides: Partial<Record<"todo" | "doing" | "in_review" | "wait_accept" | "accepted" | "rejected" | "canceled", number>> = {}) => ({
  todo: 0, doing: 0, in_review: 0, wait_accept: 0, accepted: 0, rejected: 0, canceled: 0, ...overrides,
});

test("進捗の集計規則: 取消は分母から除いて別に数え、対象なし・未起票・0件を区別し、割合は0%にしない", () => {
  const none = summarizeTaskProgress(false, false, counts());
  assert.deepEqual([none.kind, none.ratio, none.denominator], ["no_target", null, 0]);
  const unplanned = summarizeTaskProgress(true, false, counts());
  assert.deepEqual([unplanned.kind, unplanned.ratio], ["not_planned", null]);
  const empty = summarizeTaskProgress(true, true, counts());
  assert.deepEqual([empty.kind, empty.ratio, empty.total], ["no_countable_tasks", null, 0]);
  const onlyCanceled = summarizeTaskProgress(true, true, counts({ canceled: 3 }));
  assert.deepEqual([onlyCanceled.kind, onlyCanceled.ratio, onlyCanceled.canceled, onlyCanceled.total], ["no_countable_tasks", null, 3, 3]);
  const mixed = summarizeTaskProgress(true, true, counts({ accepted: 6, todo: 2, rejected: 1, in_review: 1, canceled: 2 }));
  assert.deepEqual([mixed.kind, mixed.accepted, mixed.denominator, mixed.canceled, mixed.total, mixed.ratio], ["counted", 6, 10, 2, 12, 0.6]);
  const zeroAccepted = summarizeTaskProgress(true, true, counts({ todo: 4 }));
  assert.deepEqual([zeroAccepted.kind, zeroAccepted.ratio], ["counted", 0]);
});

const seed = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const organization = asOrganizationDatabase(database);
  const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(organization)).execute({ name: "Workspace", mission: "Mission" });
  const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(organization, projectRepositoryReferenceFinder));
  const a = (await createProject.execute(workspace.id, { name: "A" }))!;
  const b = (await createProject.execute(workspace.id, { name: "B" }))!;
  const goalOne = await services.createIntentUseCase.execute(workspace.id, { title: "継続率を上げる", desiredState: "State" });
  const goalTwo = await services.createIntentUseCase.execute(workspace.id, { title: "問い合わせを減らす", desiredState: "State" });
  const input = (title: string) => ({ title, description: `${title}の説明`, intentVersion: 1, hypothesis: `${title}の仮説`, rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }] });
  const first = await services.createOutcomeUseCase.execute(workspace.id, goalOne.id, input("初回導線を短くする"));
  const second = await services.createOutcomeUseCase.execute(workspace.id, goalTwo.id, input("FAQを整える"));
  const third = await services.createOutcomeUseCase.execute(workspace.id, goalTwo.id, input("対象Projectなし"));
  return { database, services, workspace, a, b, goalOne, goalTwo, first, second, third };
};

const callTool = async (app: App, name: string, args: object, principal: string, activeRole?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${principal}`,
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result as { isError?: boolean; structuredContent: Record<string, any> };
};

const grant = (database: Database, projectId: string, principalId: string, role: string) =>
  database.insertInto("project_grant").values({ project_id: projectId, principal_id: principalId, role, created_at: Date.now() }).execute();

test("Workspace横断のOutcome一覧: 目標をまたいで集計し、検索・目標・問題で絞っても分母を変えず、詳細と同じ集計を返す", async () => {
  const { database, services, workspace, a, b, goalOne, goalTwo, first, second, third } = await seed();
  try {
    const app = await createSignedInApp(database, services);
    await seedWorkspaceGrant(database, workspace.id, "strategist-agent", "strategist");
    await grant(database, a.id, "manager-a", "manager");
    await grant(database, b.id, "manager-b", "manager");
    await grant(database, a.id, "worker-a", "worker");
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, first.id, a.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, first.id, b.id);
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, second.id, b.id);

    const story = async (projectId: string, principal: string, outcomeId: string) =>
      (await callTool(app, "issue_story", { projectId, title: "Deliver", outcomeId, requestId: `story-${principal}-${outcomeId}` }, principal)).structuredContent;
    const task = async (projectId: string, storyId: string, principal: string, key: string) =>
      (await callTool(app, "issue_task", { projectId, storyId, title: key, taskKey: key, requestId: `task-${key}` }, principal)).structuredContent;
    const storyA = await story(a.id, "manager-a", first.id);
    const storyB = await story(b.id, "manager-b", first.id);
    await task(a.id, storyA.id, "manager-a", "a-1");
    const cancelable = await task(a.id, storyA.id, "manager-a", "a-2");
    await task(b.id, storyB.id, "manager-b", "b-1");
    await database.updateTable("task").set({ status: "canceled" }).where("id", "=", cancelable.id).execute();
    await database.updateTable("task").set({ status: "accepted" }).where("project_id", "=", a.id).where("title", "=", "a-1").execute();

    const get = async (path: string) => {
      const response = await app.request(path);
      assert.equal(response.status, 200, path);
      return response.json() as Promise<any>;
    };
    const base = `/api/workspaces/${workspace.id}/outcomes`;
    const all = await get(base);
    assert.equal(all.total, 3);
    assert.equal(all.workspaceTotal, 3);
    const byId = new Map<string, any>(all.items.map((item: any) => [item.outcomeId, item]));
    // 目標をまたいで新しい順。目標名・Targetの有無を含む。
    assert.deepEqual(all.items.map((item: any) => item.outcomeId), [third.id, second.id, first.id]);
    assert.equal(byId.get(first.id).intentTitle, "継続率を上げる");
    const progress = byId.get(first.id).progress;
    // A: 受入1・取消1・分母1 / B: 分母1（todo）。取消は分母から除き、総数には含める。
    assert.deepEqual([progress.kind, progress.accepted, progress.denominator, progress.canceled, progress.total, progress.ratio], ["counted", 1, 2, 1, 3, 0.5]);
    assert.equal(progress.targetProjectCount, 2);
    // 第2 Outcomeは未起票、第3はTargetなし。どちらも0%にしない。
    assert.deepEqual([byId.get(second.id).progress.kind, byId.get(second.id).progress.ratio], ["not_planned", null]);
    assert.equal(byId.get(second.id).progress.unplannedProjectCount, 1);
    assert.deepEqual([byId.get(third.id).progress.kind, byId.get(third.id).progress.ratio], ["no_target", null]);
    assert.deepEqual(byId.get(first.id).targets.map((target: any) => [target.projectId, target.progress.denominator]), [[a.id, 1], [b.id, 1]]);

    // 検索・目標で絞っても集計（分母）は変わらない。
    const searched = await get(`${base}?q=${encodeURIComponent("初回")}`);
    assert.deepEqual(searched.items.map((item: any) => item.outcomeId), [first.id]);
    assert.equal(searched.total, 1);
    assert.equal(searched.workspaceTotal, 3);
    assert.deepEqual(searched.items[0].progress, progress);
    assert.deepEqual((await get(`${base}?q=${encodeURIComponent("継続率")}`)).items.map((item: any) => item.outcomeId), [first.id]);
    assert.deepEqual((await get(`${base}?intentId=${goalTwo.id}`)).items.map((item: any) => item.outcomeId), [third.id, second.id]);
    assert.equal((await get(`${base}?intentId=${goalOne.id}&q=FAQ`)).total, 0);

    // 詳細は一覧と同じ集計。
    const detail = await get(`${base}/${first.id}/overview`);
    assert.deepEqual(detail.progress, progress);
    assert.deepEqual(detail.targets, byId.get(first.id).targets);
    assert.deepEqual(detail.problems, byId.get(first.id).problems);

    // ページング。
    const pageOne = await get(`${base}?limit=2`);
    const pageTwo = await get(`${base}?limit=2&offset=2`);
    assert.deepEqual([pageOne.items.length, pageTwo.items.map((item: any) => item.outcomeId), pageTwo.total], [2, [first.id], 3]);
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=abc", "problem=maybe"]) {
      assert.equal((await app.request(`${base}?${query}`)).status, 400, query);
    }
    assert.equal((await app.request(`${base}/missing/overview`)).status, 404);

    // 問題: 構造化された関連（Workspace相談のOutcome参照、Storyを参照するProject相談）だけで同定し、文章の一致は使わない。
    assert.deepEqual(byId.get(first.id).problems, { state: "none" });
    const workspaceAsk = await callTool(app, "create_consultation", {
      workspaceId: workspace.id, title: "初回導線の優先度", question: "どちらを先にしますか", blockingReason: "優先度が決まらず着手できない",
      recommendation: "A", impact: "計画", requestId: "ws-ask", refs: [{ kind: "outcome", intentId: goalOne.id, id: first.id }],
    }, "strategist-agent", "strategist");
    assert.equal(workspaceAsk.isError, undefined, JSON.stringify(workspaceAsk.structuredContent));
    const projectAsk = await callTool(app, "create_consultation", {
      projectId: b.id, title: "決済仕様", question: "q", blockingReason: "初回導線の優先度が決まらず着手できない",
      recommendation: "A", impact: "i", requestId: "pj-ask", refs: [{ kind: "story", id: storyB.id }],
    }, "manager-b", "manager");
    assert.equal(projectAsk.isError, undefined, JSON.stringify(projectAsk.structuredContent));
    // 他のOutcomeの理由と文章が似ていても、参照のない相談は問題にしない。
    await callTool(app, "create_consultation", {
      projectId: a.id, title: "初回導線を短くする", question: "q", blockingReason: "初回導線を短くする",
      recommendation: "A", impact: "i", requestId: "unrelated", refs: [],
    }, "worker-a", "worker");

    const withProblems = await get(`${base}?problem=present`);
    assert.deepEqual(withProblems.items.map((item: any) => item.outcomeId), [first.id]);
    const problems = withProblems.items[0].problems;
    assert.equal(problems.state, "present");
    assert.equal(problems.items.length, 2);
    assert.equal(problems.otherCount, 1);
    assert.equal(problems.waitingHumanCount, 2);
    assert.equal(problems.representative.kind, "waiting_human");
    assert.deepEqual(new Set(problems.items.map((item: any) => item.scope)), new Set(["workspace", "project"]));
    assert.deepEqual((await get(`${base}?problem=none`)).items.map((item: any) => item.outcomeId), [third.id, second.id]);
    assert.equal((await get(`${base}?problem=unknown`)).total, 0);
    const detailWithProblems = await get(`${base}/${first.id}/overview`);
    assert.deepEqual(detailWithProblems.problems, problems);
    // 提供状況は公開確認の対象となる変更が無ければ対象なし、効果は評価が無ければ未評価。一覧と詳細は同じ値で、Task進捗から推測しない。
    assert.deepEqual({ delivery: detailWithProblems.delivery, effect: detailWithProblems.effect }, { delivery: { state: "no_changes" }, effect: { state: "not_evaluated" } });
    assert.deepEqual(withProblems.items[0].delivery, detailWithProblems.delivery);
    assert.deepEqual(withProblems.items[0].effect, detailWithProblems.effect);
    // 問題の有無で絞っても分母は変わらない。
    assert.deepEqual(withProblems.items[0].progress, progress);
  } finally {
    await database.destroy();
  }
});

test("問題を取得できないときは「問題なし」ではなく「未取得」にし、問題なしの絞り込みへ含めない", async () => {
  const outcome = (id: string, intentId: string) => ({ id, intentId, title: id, description: "", hypothesis: null, status: "active", createdAt: 1, updatedAt: 1 });
  const outcomes = [outcome("o1", "i1"), outcome("o2", "i1")];
  const intent = { id: "i1", title: "Goal", status: "active" };
  const noDelivery: OutcomeDeliveryPort = { listOutcomeDeliveries: async () => [] };
  const deps = (problemPort: OutcomeProblemPort, deliveryPort: OutcomeDeliveryPort = noDelivery) => [
    { findById: async () => ({ id: "w" }) } as never,
    { findByWorkspace: async () => [intent], findById: async () => intent } as never,
    { findByWorkspace: async () => outcomes, findByIdInWorkspace: async (_w: string, id: string) => outcomes.find((item) => item.id === id) ?? null } as never,
    { listByWorkspace: async () => [], listByOutcome: async () => [] } as never,
    { summarizeOutcomeProjects: async () => [] },
    problemPort,
    { findByOutcome: async (_w: string, outcomeId: string) => (outcomeId === "o1" ? [{ result: "achieved", createdAt: 7 }] : []) } as never,
    deliveryPort,
  ] as const;
  const fact: OutcomeProblemFact = { consultationId: "c", kind: "waiting_agent", scope: "workspace", title: "t", reason: "r", projectIds: [], taskIds: [], updatedAt: 1 };
  const failing: OutcomeProblemPort = { listOutcomeProblems: async () => { throw new Error("unavailable"); } };
  const [w, i, o, t, s, p, e, d] = deps(failing);
  const down = { list: new ListWorkspaceOutcomesUseCase(w, i, o, t, s, p, e, d), get: new GetWorkspaceOutcomeOverviewUseCase(w, i, o, t, s, p, e, d) };
  const page = await down.list.execute("w");
  assert.deepEqual([...new Set(page.items.map((item) => item.problems.state))], ["unknown"]);
  assert.equal((await down.list.execute("w", { problem: "none" })).total, 0);
  assert.equal((await down.list.execute("w", { problem: "unknown" })).total, 2);
  assert.equal((await down.get.execute("w", "o1")).problems.state, "unknown");

  // 同じ相談IDは複数の経路から見つかっても1件に数える。取得できれば、問題の無いOutcomeは「なし」。
  const available: OutcomeProblemPort = {
    listOutcomeProblems: async (_w, ids) => ids.map((outcomeId) => ({ outcomeId, problems: outcomeId === "o1" ? [fact, { ...fact }] : [] })),
  };
  const [w2, i2, o2, t2, s2, p2, e2, d2] = deps(available);
  const up = new ListWorkspaceOutcomesUseCase(w2, i2, o2, t2, s2, p2, e2, d2);
  const present = (await up.execute("w")).items.map((item) => item.problems);
  assert.deepEqual(present.map((problems) => problems.state), ["present", "none"]);
  // Targetの無いOutcomeは公開確認の対象となる変更が無い。効果は最新の評価だけで決め、評価の無いOutcomeは未評価（Task進捗から推測しない）。
  const confirmations = (await up.execute("w")).items.map(({ delivery, effect }) => ({ delivery, effect }));
  assert.deepEqual(confirmations, [
    { delivery: { state: "no_changes" }, effect: { state: "evaluated", result: "achieved", evaluatedAt: 7 } },
    { delivery: { state: "no_changes" }, effect: { state: "not_evaluated" } },
  ]);
  assert.equal(present[0]?.state === "present" && present[0].items.length, 1);
});

test("提供状況は公開記録の変更別の公開状況から数え、取得できないProjectを変更なし・公開なしにしない", async () => {
  const outcome = { id: "o1", intentId: "i1", title: "o1", description: "", hypothesis: null, status: "active", createdAt: 1, updatedAt: 1 };
  const intent = { id: "i1", title: "Goal", status: "active" };
  const targets = ["p1", "p2"].map((projectId) => ({ outcomeId: "o1", projectId, projectStatus: "active" }));
  const noProblems: OutcomeProblemPort = { listOutcomeProblems: async (_w, ids) => ids.map((outcomeId) => ({ outcomeId, problems: [] })) };
  const build = (deliveryPort: OutcomeDeliveryPort) => {
    const args = [
      { findById: async () => ({ id: "w" }) } as never,
      { findByWorkspace: async () => [intent], findById: async () => intent } as never,
      { findByWorkspace: async () => [outcome], findByIdInWorkspace: async () => outcome } as never,
      { listByWorkspace: async () => targets, listByOutcome: async () => targets } as never,
      { summarizeOutcomeProjects: async () => [] },
      noProblems,
      { findByOutcome: async () => [] } as never,
      deliveryPort,
    ] as const;
    return { list: new ListWorkspaceOutcomesUseCase(...args), get: new GetWorkspaceOutcomeOverviewUseCase(...args) };
  };
  const change = (taskId: string, status: "published" | "not_published" | "unconfirmed", reason: "not_configured" | "no_record" | null = null) => ({ taskId, status, reason });
  const known = build({
    listOutcomeDeliveries: async () => [
      { outcomeId: "o1", projectId: "p1", changes: [change("t1", "published"), change("t2", "unconfirmed", "no_record")] },
      { outcomeId: "o1", projectId: "p2", changes: [change("t3", "unconfirmed", "not_configured"), change("t4", "not_published")] },
    ],
  });
  const expected = { state: "tracked", changeCount: 4, published: 1, notPublished: 1, unconfirmed: 2, notConfigured: 1 };
  assert.deepEqual((await known.list.execute("w")).items[0]?.delivery, expected);
  assert.deepEqual((await known.get.execute("w", "o1")).delivery, expected);

  // 変更が無いProjectだけなら対象なし。一部のProjectを取得できない・ポートが返さないTargetは未取得で、公開なしや対象なしにしない。
  const none = build({ listOutcomeDeliveries: async () => targets.map(({ projectId }) => ({ outcomeId: "o1", projectId, changes: [] })) });
  assert.deepEqual((await none.get.execute("w", "o1")).delivery, { state: "no_changes" });
  const partial = build({
    listOutcomeDeliveries: async () => [
      { outcomeId: "o1", projectId: "p1", changes: [change("t1", "published")] },
      { outcomeId: "o1", projectId: "p2", changes: null },
    ],
  });
  assert.deepEqual((await partial.get.execute("w", "o1")).delivery, { state: "unknown" });
  const missing = build({ listOutcomeDeliveries: async () => [{ outcomeId: "o1", projectId: "p1", changes: [] }] });
  assert.deepEqual((await missing.list.execute("w")).items[0]?.delivery, { state: "unknown" });
  const failing = build({ listOutcomeDeliveries: async () => { throw new Error("unavailable"); } });
  assert.deepEqual((await failing.get.execute("w", "o1")).delivery, { state: "unknown" });
});
