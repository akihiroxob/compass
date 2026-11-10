import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { parseProjectStatusFilter, parseWorkspaceStatusFilter } from "@compass/organization";

export const registerOrganizationRoutes = (app: Hono, context: HttpRequestContext) => {
  const { services, human, actorOf, readJsonBody } = context;
  // Projectと専用のWorkspaceを作り、作成者を同一transactionでWorkspaceのowner Membershipにする。
  app.post("/api/projects", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw);
    const project = await services.createProjectUseCase.execute(input, actor);
    return c.json({ project }, 201);
  });
  // 有効なWorkspace Membershipを持つWorkspaceのProjectだけ。既定はactiveのみ。`?status=archived`でアーカイブ済み一覧。それ以外の値は400（path `status`）。
  app.get("/api/projects", async (c) => {
    const actor = await actorOf(c);
    return c.json({ projects: await human.listProjects.execute(actor, parseProjectStatusFilter(c.req.query("status"))) });
  });
  // `myRole`はUIの導線切替用。拒否は常にserverの権限表で行う。
  app.get("/api/projects/:projectId", async (c) =>
    c.json(await human.getProject.execute(await actorOf(c), c.req.param("projectId"))),
  );
  app.patch("/api/projects/:projectId", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw);
    const project = await human.updateProject.execute(actor, c.req.param("projectId"), input);
    return c.json({ project });
  });

  // Workspaceの作成・参照・更新・archiveと、既存WorkspaceへのProject作成。Workspace Membershipで認可する（未所属・不在は404）。
  // 作成は認証済みであればよく、作成者を同一transactionでowner Membershipにする。作成したProjectは同じMembershipで利用する。
  app.post("/api/workspaces", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Workspace");
    return c.json({ workspace: await human.createWorkspace.execute(input, actor) }, 201);
  });
  // 有効なMembershipを持つWorkspaceだけ。既定はactiveのみ。`?status=archived`でアーカイブ済み一覧。
  app.get("/api/workspaces", async (c) => {
    const actor = await actorOf(c);
    return c.json({ workspaces: await human.listWorkspaces.execute(actor, parseWorkspaceStatusFilter(c.req.query("status"))) });
  });
  app.get("/api/workspaces/:workspaceId", async (c) =>
    c.json(await human.getWorkspace.execute(await actorOf(c), c.req.param("workspaceId"))),
  );
  // 所属Projectの一覧（purpose・Repository・Resource）。Mission等はWorkspaceの応答を参照する。
  app.get("/api/workspaces/:workspaceId/projects", async (c) => {
    const actor = await actorOf(c);
    const status = parseProjectStatusFilter(c.req.query("status"));
    return c.json({ projects: await human.listWorkspaceProjects.execute(actor, c.req.param("workspaceId"), status) });
  });
  // Mission等の更新はadministrator以上。archivedのWorkspaceは409（`workspaceStatus: archived`）。
  app.patch("/api/workspaces/:workspaceId", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Workspace");
    return c.json({ workspace: await human.updateWorkspace.execute(actor, c.req.param("workspaceId"), input) });
  });
  // 既存WorkspaceへのProject作成（administrator以上）。WorkspaceのMemberが同じRoleで利用する。Mission等はWorkspaceの正本を使う。
  app.post("/api/workspaces/:workspaceId/projects", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw);
    return c.json({ project: await human.createWorkspaceProject.execute(actor, c.req.param("workspaceId"), input) }, 201);
  });
  // archiveはowner。Human向けのWeb API専用で、MCP tool・CLIコマンドへは公開せず、復帰・削除のAPIも作らない。
  app.post("/api/workspaces/:workspaceId/archive", async (c) => {
    const actor = await actorOf(c);
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Workspace") : {};
    return c.json({ workspace: await human.archiveWorkspace.execute(actor, c.req.param("workspaceId"), input) });
  });

  // archiveはHuman向けのWeb API専用。MCP tool・CLIコマンドへは公開せず、復帰・削除のAPIも作らない。
  app.post("/api/projects/:projectId/archive", async (c) => {
    const actor = await actorOf(c);
    // 本文なしの要求は、理由なしとしてuse caseのVALIDATION_ERRORにする。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw) : {};
    const project = await human.archiveProject.execute(actor, c.req.param("projectId"), input);
    return c.json({ project });
  });
};
