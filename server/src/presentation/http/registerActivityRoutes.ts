import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { type Context } from "hono";
import { queryNumber } from "./httpQuery.ts";

export const registerActivityRoutes = (app: Hono, context: HttpRequestContext) => {
  const { human, actorOf } = context;
  // Activity一覧のquery。新しい順のページング（`beforeCursor`・`limit`）と種別（`type`、完全一致）の絞り込みだけを受け付け、検証はuse caseが行う。
  const activityListQuery = (c: Context) => ({
    beforeCursor: queryNumber(c.req.query("beforeCursor")),
    limit: queryNumber(c.req.query("limit")),
    ...(c.req.query("type") === undefined ? {} : { type: c.req.query("type") }),
  });
  // Workspace Activity閲覧。Workspace Membership（viewer以上）で認可し、Workspace scopeのsummary・refsと1件の本文・訂正を返す。
  // 所属ProjectのActivityは含めない（所属WorkspaceのMembershipで`/api/projects/:projectId/activities`から読む）。Web UIからは記録しない。
  app.get("/api/workspaces/:workspaceId/activities", async (c) =>
    c.json(
      await human.listWorkspaceActivities.execute(await actorOf(c), c.req.param("workspaceId"), activityListQuery(c)),
    ),
  );
  // Workspace共通と所属全Project（archivedを含む）の業務Activityの横断一覧。Workspace Membership（viewer以上）で認可する。
  // `before` / `after`は応答の`nextCursor`、`from` / `to`は発生時刻（epoch ms）、`projectId` / `workspaceOnly=true`は対象、`q`は検索語。
  app.get("/api/workspaces/:workspaceId/activity-stream", async (c) => {
    const text = c.req.query("q")?.trim();
    const textFilter = text === undefined || text === "" ? {} : { text };
    return c.json(
      await human.listWorkspaceActivityStream.execute(await actorOf(c), c.req.param("workspaceId"), {
        limit: queryNumber(c.req.query("limit")),
        from: queryNumber(c.req.query("from")),
        to: queryNumber(c.req.query("to")),
        ...(c.req.query("before") === undefined ? {} : { before: c.req.query("before") }),
        ...(c.req.query("after") === undefined ? {} : { after: c.req.query("after") }),
        ...(c.req.query("projectId") === undefined ? {} : { projectId: c.req.query("projectId") }),
        ...(c.req.query("workspaceOnly") === undefined ? {} : { workspaceOnly: c.req.query("workspaceOnly") === "true" }),
        ...(c.req.query("type") === undefined ? {} : { type: c.req.query("type") }),
        ...textFilter,
      }),
    );
  });
  app.get("/api/workspaces/:workspaceId/activities/:activityId", async (c) =>
    c.json(await human.getWorkspaceActivity.execute(await actorOf(c), c.req.param("workspaceId"), c.req.param("activityId"))),
  );
  // Activity閲覧。Membership（viewer以上）で認可し、新しい順のsummary・refsと、1件の本文・訂正を返す。記録はAgentのMCPとcanonical生成だけ。
  app.get("/api/projects/:projectId/activities", async (c) =>
    c.json(
      await human.listActivities.execute(await actorOf(c), c.req.param("projectId"), activityListQuery(c)),
    ),
  );
  app.get("/api/projects/:projectId/activities/:activityId", async (c) =>
    c.json(await human.getActivity.execute(await actorOf(c), c.req.param("projectId"), c.req.param("activityId"))),
  );
};
