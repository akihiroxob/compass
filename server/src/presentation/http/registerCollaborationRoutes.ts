import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { type Context } from "hono";
import type { HumanActor } from "@compass/access";

export const registerCollaborationRoutes = (app: Hono, context: HttpRequestContext) => {
  const { human, actorOf, readJsonBody } = context;
  // 相談（判断待ち）。scopeのMembershipで認可し（参照はviewer、返信はeditor、明示決定・取消はadministrator以上）、MCPと同じuse caseへ委譲する。
  // Projectは所属Workspace、WorkspaceはそのWorkspaceのMembershipで認可する。記録主体はSessionのHumanから導出し、本文では受け取らない。
  // 相談の作成・Agentの応答leaseはMCPだけ。
  const consultationRoutes = (
    scopePath: string,
    scopeParam: "projectId" | "workspaceId",
    handlers: {
      list: { execute(actor: HumanActor, scopeId: string, query: unknown): Promise<unknown> };
      get: { execute(actor: HumanActor, scopeId: string, consultationId: string): Promise<unknown> };
      reply: { execute(actor: HumanActor, scopeId: string, consultationId: string, input: unknown): Promise<unknown> };
      decide: { execute(actor: HumanActor, scopeId: string, consultationId: string, input: unknown): Promise<unknown> };
      cancel: { execute(actor: HumanActor, scopeId: string, consultationId: string, input: unknown): Promise<unknown> };
    },
  ) => {
    const consultationsPath = `${scopePath}/consultations`;
    const consultationPath = `${consultationsPath}/:consultationId`;
    // routeのpathが動的なため型からparamを導けない。どちらのparamもroute定義に必ず含まれる。
    const scopeIdOf = (c: Context) => c.req.param(scopeParam) ?? "";
    const consultationIdOf = (c: Context) => c.req.param("consultationId") ?? "";
    app.get(consultationsPath, async (c) => {
      const status = c.req.query("status");
      return c.json(await handlers.list.execute(await actorOf(c), scopeIdOf(c), status === undefined ? {} : { status }));
    });
    app.get(consultationPath, async (c) =>
      c.json(await handlers.get.execute(await actorOf(c), scopeIdOf(c), consultationIdOf(c))),
    );
    app.post(`${consultationPath}/messages`, async (c) => {
      const actor = await actorOf(c);
      const input = await readJsonBody(c.req.raw, "Consultation message");
      return c.json(await handlers.reply.execute(actor, scopeIdOf(c), consultationIdOf(c), input), 201);
    });
    app.post(`${consultationPath}/resolution`, async (c) => {
      const actor = await actorOf(c);
      const input = await readJsonBody(c.req.raw, "Consultation resolution");
      return c.json(await handlers.decide.execute(actor, scopeIdOf(c), consultationIdOf(c), input), 201);
    });
    app.post(`${consultationPath}/cancel`, async (c) => {
      const actor = await actorOf(c);
      const input = await readJsonBody(c.req.raw, "Consultation cancel");
      return c.json(await handlers.cancel.execute(actor, scopeIdOf(c), consultationIdOf(c), input));
    });
  };
  consultationRoutes("/api/projects/:projectId", "projectId", {
    list: human.listConsultations, get: human.getConsultation, reply: human.replyConsultation,
    decide: human.decideConsultation, cancel: human.cancelConsultation,
  });
  consultationRoutes("/api/workspaces/:workspaceId", "workspaceId", {
    list: human.listWorkspaceConsultations, get: human.getWorkspaceConsultation, reply: human.replyWorkspaceConsultation,
    decide: human.decideWorkspaceConsultation, cancel: human.cancelWorkspaceConsultation,
  });
  // 横断した判断待ち一覧。閲覧できるProject・Workspaceの相談だけを返し、`status`（既定waiting_human、`all`で全状態）・`scope`・
  // `projectId`・`workspaceId`での絞り込みと`limit`・`cursor`のページングは認可済みの集合に対して行う。閲覧できないscopeの指定は空になる。
  app.get("/api/consultations", async (c) => {
    const actor = await actorOf(c);
    const query = Object.fromEntries(
      (["status", "scope", "projectId", "workspaceId", "sort", "limit", "cursor"] as const).flatMap((name) => {
        const value = c.req.query(name);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    return c.json(await human.listAccessibleConsultations.execute(actor, query));
  });
};
