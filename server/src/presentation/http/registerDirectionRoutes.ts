import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { queryNumber } from "./httpQuery.ts";

export const registerDirectionRoutes = (app: Hono, context: HttpRequestContext) => {
  const { human, actorOf, readJsonBody } = context;

  // Workspace Direction（Intent・Outcome）。Workspace Membershipで認可し、MCPと同じapplication use caseへ委譲する。
  // Project配下の旧経路はWorkspaceの別名として残さない。
  app.post("/api/workspaces/:workspaceId/intents", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Intent");
    const intent = await human.createIntent.execute(actor, c.req.param("workspaceId"), input);
    return c.json({ intent }, 201);
  });
  app.get("/api/workspaces/:workspaceId/intents", async (c) =>
    c.json({ intents: await human.listIntents.execute(await actorOf(c), c.req.param("workspaceId")) }),
  );
  app.get("/api/workspaces/:workspaceId/intents/:intentId", async (c) =>
    c.json({
      intent: await human.getIntent.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("intentId")),
    }),
  );
  app.get("/api/workspaces/:workspaceId/intents/:intentId/revisions", async (c) =>
    c.json({
      revisions: await human.listIntentRevisions.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("intentId")),
    }),
  );
  app.patch("/api/workspaces/:workspaceId/intents/:intentId", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Intent");
    const intent = await human.updateIntent.execute(
      actor,
      c.req.param("workspaceId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ intent });
  });
  app.post("/api/workspaces/:workspaceId/intents/:intentId/abandon", async (c) => {
    const actor = await actorOf(c);
    // 放棄理由は任意のため、本文なしの要求は理由なしとして扱う。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Intent") : {};
    const intent = await human.abandonIntent.execute(
      actor,
      c.req.param("workspaceId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ intent });
  });

  const outcomesPath = "/api/workspaces/:workspaceId/intents/:intentId/outcomes";
  app.post(outcomesPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Outcome");
    const outcome = await human.createOutcome.execute(
      actor,
      c.req.param("workspaceId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ outcome }, 201);
  });
  app.get(outcomesPath, async (c) =>
    c.json({
      outcomes: await human.listOutcomes.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("intentId")),
    }),
  );
  app.get(`${outcomesPath}/:outcomeId`, async (c) =>
    c.json({
      outcome: await human.getOutcome.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("intentId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  app.patch(`${outcomesPath}/:outcomeId`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Outcome");
    const outcome = await human.updateOutcome.execute(
      actor,
      c.req.param("workspaceId"),
      c.req.param("intentId"),
      c.req.param("outcomeId"),
      input,
    );
    return c.json({ outcome });
  });
  app.post(`${outcomesPath}/:outcomeId/cancel`, async (c) => {
    const actor = await actorOf(c);
    // 本文なしの要求は、理由なしとしてuse caseのVALIDATION_ERRORにする。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Outcome") : {};
    const outcome = await human.cancelOutcome.execute(
      actor,
      c.req.param("workspaceId"),
      c.req.param("intentId"),
      c.req.param("outcomeId"),
      input,
    );
    return c.json({ outcome });
  });
  // Research・Direction Decision・ADR参照はHuman向けの読み取り専用画面（Task 29）。Agent Role Grantではなく
  // Workspace Membership（viewer以上）で認可し、MCPのResearcher/Strategist tool群と同じapplication use caseへ委譲する。
  app.get("/api/workspaces/:workspaceId/research-requests", async (c) => {
    const actor = await actorOf(c);
    const filter = { originIntentId: c.req.query("originIntentId"), status: c.req.query("status") };
    return c.json({
      requests: await human.listResearchRequests.execute(actor, c.req.param("workspaceId"), filter),
    });
  });
  app.get("/api/workspaces/:workspaceId/research-requests/:requestId", async (c) =>
    c.json({
      detail: await human.getResearchRequest.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("requestId"),
      ),
    }),
  );
  app.get("/api/workspaces/:workspaceId/intents/:intentId/decisions", async (c) =>
    c.json({
      decisions: await human.listDirectionDecisions.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("intentId"),
      ),
    }),
  );
  // Intentの観測項目についてのAgentの説明（Workspace member）。新しい順で、根拠は原記録から解決する。
  // 説明が無い場合は空配列で、観測項目ごとの観測状態（未計測・取得失敗・古い観測）を併せて返す。
  app.get("/api/workspaces/:workspaceId/intents/:intentId/explanations", async (c) =>
    c.json(await human.listIntentExplanations.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("intentId"))),
  );
  // Intentの観測項目と、現在の観測状態・時系列（Workspace member）。`from`・`to`（`YYYY-MM-DD`）で範囲を指定し、既定は今日までの30日。
  // 観測の無い期間は含めず、未計測・取得失敗・古い観測は`current.state`で区別する。
  app.get("/api/workspaces/:workspaceId/intents/:intentId/metrics", async (c) =>
    c.json(
      await human.listIntentMetrics.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("intentId"), {
        ...(c.req.query("from") === undefined ? {} : { from: c.req.query("from") }),
        ...(c.req.query("to") === undefined ? {} : { to: c.req.query("to") }),
      }),
    ),
  );
  app.get("/api/workspaces/:workspaceId/adr-references", async (c) =>
    c.json({ references: await human.listAdrReferences.execute(await actorOf(c), c.req.param("workspaceId")) }),
  );
  app.get("/api/workspaces/:workspaceId/outcomes/:outcomeId/evaluations", async (c) =>
    c.json({
      evaluations: await human.listOutcomeEvaluations.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  // Target Projectの参照（Workspace member）。設定・解除はStrategistの判断で、MCPだけに公開する。
  app.get("/api/workspaces/:workspaceId/outcomes/:outcomeId/target-projects", async (c) =>
    c.json({
      targets: await human.listOutcomeTargetProjects.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  // OutcomeへのTarget別のExecution Summary・Evidence参照（Workspace member）。Project別に分け、本文は含まない。
  app.get("/api/workspaces/:workspaceId/outcomes/:outcomeId/target-executions", async (c) =>
    c.json(
      await human.listOutcomeTargetExecutions.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("outcomeId"),
      ),
    ),
  );
  // Intentをまたぐ Outcome一覧（Workspace member）。検索・目標・問題の有無で絞り、新しい順にページングする。
  // Task進捗は検索・絞り込みと無関係に集計し、詳細（`/outcomes/:outcomeId/overview`）と同じ組み立てを使う。
  app.get("/api/workspaces/:workspaceId/outcomes", async (c) =>
    c.json(
      await human.listWorkspaceOutcomes.execute(await actorOf(c), c.req.param("workspaceId"), {
        ...(c.req.query("q") === undefined ? {} : { q: c.req.query("q") }),
        ...(c.req.query("intentId") === undefined ? {} : { intentId: c.req.query("intentId") }),
        ...(c.req.query("problem") === undefined ? {} : { problem: c.req.query("problem") as "present" | "none" | "unknown" }),
        limit: queryNumber(c.req.query("limit")),
        offset: queryNumber(c.req.query("offset")),
      }),
    ),
  );
  app.get("/api/workspaces/:workspaceId/outcomes/:outcomeId/overview", async (c) =>
    c.json(
      await human.getWorkspaceOutcomeOverview.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("outcomeId")),
    ),
  );
  // OutcomeごとのTarget別Work要約（Workspace member）。Story / Task本文はProjectのExecution閲覧から読む。
  app.get("/api/workspaces/:workspaceId/intents/:intentId/outcome-target-work", async (c) =>
    c.json({
      outcomes: await human.listOutcomeTargetWork.execute(
        await actorOf(c),
        c.req.param("workspaceId"),
        c.req.param("intentId"),
      ),
    }),
  );
};
