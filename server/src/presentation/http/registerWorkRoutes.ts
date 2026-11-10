import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { queryNumber } from "./httpQuery.ts";

export const registerWorkRoutes = (app: Hono, context: HttpRequestContext) => {
  const { human, actorOf, readJsonBody } = context;
  // リリース履歴（所属WorkspaceのMembership）。変更ごとに開発の受入と公開の状況を別の項目で返し、公開記録の原記録も返す。
  app.get("/api/projects/:projectId/releases", async (c) =>
    c.json(await human.listProjectReleases.execute(await actorOf(c), c.req.param("projectId"))),
  );
  // Human向けの読取（所属WorkspaceのMembership）。還流済みのProjectのExecutionの結果・Evidence参照を返す（還流前は`record: null`）。
  app.get("/api/projects/:projectId/outcomes/:outcomeId/execution-summary", async (c) =>
    c.json({
      record: await human.getExecutionSummary.execute(
        await actorOf(c),
        c.req.param("projectId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  // Execution閲覧（Task 45。docs/lv6-unification-design.md「Web UIの配置と移行順」U2）。GETだけで、Execution serviceの
  // Grant不要な読取へMembership（viewer以上）の認可後に委譲する。MCP・SQLite tableをWeb UIから直接使わない。
  app.get("/api/projects/:projectId/execution", async (c) => {
    const actor = await actorOf(c);
    const outcomeId = c.req.query("outcomeId");
    return c.json(await human.listExecution.execute(actor, c.req.param("projectId"), outcomeId === undefined ? {} : { outcomeId }));
  });
  // 開発詳細の検索・ページング（UI-W1）。検索・状態・Outcomeの絞り込みと件数・ページをサーバーで決める。
  app.get("/api/projects/:projectId/work", async (c) => {
    const actor = await actorOf(c);
    const optional = (name: string) => c.req.query(name);
    return c.json(
      await human.searchExecutionWork.execute(actor, c.req.param("projectId"), {
        ...(optional("view") === undefined ? {} : { view: optional("view") }),
        ...(optional("q") === undefined ? {} : { q: optional("q") }),
        ...(optional("status") === undefined ? {} : { status: optional("status") }),
        ...(optional("outcome") === undefined ? {} : { outcome: optional("outcome") }),
        ...(optional("storyId") === undefined ? {} : { storyId: optional("storyId") }),
        ...(optional("page") === undefined ? {} : { page: queryNumber(optional("page")) }),
      }),
    );
  });
  app.get("/api/projects/:projectId/tasks/:taskId", async (c) =>
    c.json(await human.getExecutionTask.execute(await actorOf(c), c.req.param("projectId"), c.req.param("taskId"))),
  );
  app.get("/api/projects/:projectId/changes", async (c) =>
    c.json(
      await human.listRecentExecutionChanges.execute(await actorOf(c), c.req.param("projectId"), {
        beforeCursor: queryNumber(c.req.query("beforeCursor")),
        limit: queryNumber(c.req.query("limit")),
      }),
    ),
  );
  // Execution介入（Task 46。U3）。Membershipのeditor以上＝`execution.intervene`。操作者はSessionのHumanから導出し、本文では受け取らない。
  const taskPath = "/api/projects/:projectId/tasks/:taskId";
  app.post(`${taskPath}/accept`, async (c) =>
    c.json(await human.acceptExecutionTask.execute(await actorOf(c), c.req.param("projectId"), c.req.param("taskId"))),
  );
  app.post(`${taskPath}/reject`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Task");
    return c.json(await human.rejectExecutionTask.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input));
  });
  app.post(`${taskPath}/cancel`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Task");
    return c.json(await human.cancelExecutionTask.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input));
  });
  app.post(`${taskPath}/comments`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Comment");
    return c.json(await human.addExecutionTaskComment.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input), 201);
  });
  // Story・Taskの手動起票・編集（Task 47。U4）。Membershipのeditor以上＝`execution.plan`。相関ID・taskKeyは受け付けない。
  app.post("/api/projects/:projectId/stories", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Story");
    return c.json({ story: await human.createExecutionStory.execute(actor, c.req.param("projectId"), input) }, 201);
  });
  app.patch("/api/projects/:projectId/stories/:storyId", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Story");
    return c.json({ story: await human.editExecutionStory.execute(actor, c.req.param("projectId"), c.req.param("storyId"), input) });
  });
  app.post("/api/projects/:projectId/tasks", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Task");
    return c.json({ task: await human.createExecutionTask.execute(actor, c.req.param("projectId"), input) }, 201);
  });
  app.patch(taskPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Task");
    return c.json({ task: await human.editExecutionTask.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input) });
  });
};
