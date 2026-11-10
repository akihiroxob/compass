import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { type Context } from "hono";
import type { CredentialScope } from "@compass/access";

export const registerAccessRoutes = (app: Hono, context: HttpRequestContext) => {
  const { services, human, actorOf, humanAuth, readJsonBody } = context;
  const grantsPath = "/api/projects/:projectId/grants";
  app.post(grantsPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Grant");
    const { grant, created } = await human.grantProjectRole.execute(actor, c.req.param("projectId"), input);
    return c.json({ grant, created }, created ? 201 : 200);
  });
  app.get(grantsPath, async (c) =>
    c.json({ grants: await human.listProjectGrants.execute(await actorOf(c), c.req.param("projectId")) }),
  );
  // 取消は冪等に扱うため、Grantの特定はbodyでなくpathに置く（principalIdはURLエンコード）。
  app.delete(`${grantsPath}/:role/:principalId`, async (c) => {
    const actor = await actorOf(c);
    const revoked = await human.revokeProjectRole.execute(actor, c.req.param("projectId"), {
      role: c.req.param("role"),
      principalId: c.req.param("principalId"),
    });
    return c.json({ revoked });
  });
  // Workspace Direction Role（strategist / researcher / evaluator）のAgent Grant。Workspace Membership（参照はviewer以上、
  // 付与・取消はadministrator以上）で認可し、Project Grantは含めない。取消はProject Grantと同じくpathで特定し冪等に扱う。
  const workspaceGrantsPath = "/api/workspaces/:workspaceId/grants";
  app.get(workspaceGrantsPath, async (c) =>
    c.json({ grants: await human.listWorkspaceGrants.execute(await actorOf(c), c.req.param("workspaceId")) }),
  );
  app.post(workspaceGrantsPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Grant");
    const { grant, created } = await human.grantWorkspaceRole.execute(actor, c.req.param("workspaceId"), input);
    return c.json({ grant, created }, created ? 201 : 200);
  });
  // Agentの実行観測（Ralph・Orchestratorの報告）。Workspace Membership（viewer以上）で読み、`principalId`でそのAgentの履歴に絞る。
  app.get("/api/workspaces/:workspaceId/agent-runs", async (c) => {
    const principalId = c.req.query("principalId");
    return c.json(await human.listWorkspaceAgentRuns.execute(await actorOf(c), c.req.param("workspaceId"), principalId === undefined ? {} : { principalId }));
  });
  app.delete(`${workspaceGrantsPath}/:role/:principalId`, async (c) => {
    const actor = await actorOf(c);
    const revoked = await human.revokeWorkspaceRole.execute(actor, c.req.param("workspaceId"), {
      role: c.req.param("role"),
      principalId: c.req.param("principalId"),
    });
    return c.json({ revoked });
  });
  // Role DefinitionとSkillのmetadata（Git管理の資産）。認証済みHumanが、Agent画面からRoleの責務・Skillを辿るために読む。
  app.get("/api/agent-roles/:role", async (c) =>
    c.json(await human.getAgentRole.execute(await actorOf(c), c.req.param("role"))),
  );
  // HumanのMembershipはWorkspace単位だけ（ADR 0003）。一覧はviewer以上、Role変更・除外はowner（権限表は`humanWorkspacePermissions`）。
  // 変更・除外は配下の全Projectへの次の操作から反映する。Project単位のMember APIは持たない。
  const workspaceMembersPath = "/api/workspaces/:workspaceId/members";
  app.get(workspaceMembersPath, async (c) =>
    c.json({ members: await human.listWorkspaceMembers.execute(await actorOf(c), c.req.param("workspaceId")) }),
  );
  app.patch(`${workspaceMembersPath}/:membershipId`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Membership");
    const membership = await human.changeWorkspaceMemberRole.execute(actor, c.req.param("workspaceId"), c.req.param("membershipId"), input);
    return c.json({ membership });
  });
  app.delete(`${workspaceMembersPath}/:membershipId`, async (c) => {
    const actor = await actorOf(c);
    const membership = await human.revokeWorkspaceMember.execute(actor, c.req.param("workspaceId"), c.req.param("membershipId"));
    return c.json({ membership });
  });
  // Workspaceのownerが発行する招待。Projectがなくても参加できる。
  const invitationsPath = "/api/workspaces/:workspaceId/invitations";
  app.get(invitationsPath, async (c) =>
    c.json({
      invitations: await services.listWorkspaceInvitationsUseCase.execute(await actorOf(c), c.req.param("workspaceId")),
    }),
  );
  // tokenの平文は発行応答で一度だけ返す。リンクはURL fragmentで渡し、access logへ残さない。
  app.post(invitationsPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Invitation");
    const { invitation, token } = await services.createWorkspaceInvitationUseCase.execute(
      actor,
      c.req.param("workspaceId"),
      input,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ invitation, invitationUrl: `${humanAuth.publicOrigin}/invite#${token}` }, 201);
  });
  app.delete(`${invitationsPath}/:invitationId`, async (c) => {
    const actor = await actorOf(c);
    const invitation = await services.revokeWorkspaceInvitationUseCase.execute(
      actor,
      c.req.param("workspaceId"),
      c.req.param("invitationId"),
    );
    return c.json({ invitation });
  });
  // Agent / Runtime Credential（Task 37）。scope（Workspace / Project）のAdministrator以上。secretは発行・rotationの応答で一度だけ返す。
  // Workspace Credentialは所属Projectの操作に使えず、Project CredentialはWorkspaceの操作に使えない。
  const credentialRoutes = (kind: CredentialScope["kind"]) => {
    const parameter = kind === "workspace" ? "workspaceId" : "projectId";
    const path = `/api/${kind === "workspace" ? "workspaces" : "projects"}/:${parameter}/credentials`;
    const scopeOf = (c: Context): CredentialScope => ({ kind, id: c.req.param(parameter) ?? "" });
    app.get(path, async (c) =>
      c.json({ credentials: await services.listAccessCredentialsUseCase.execute(await actorOf(c), scopeOf(c)) }),
    );
    app.post(path, async (c) => {
      const actor = await actorOf(c);
      const input = await readJsonBody(c.req.raw, "Credential");
      const issued = await services.issueAccessCredentialUseCase.execute(actor, scopeOf(c), input);
      c.header("Cache-Control", "no-store");
      return c.json(issued, 201);
    });
    app.post(`${path}/:credentialId/rotate`, async (c) => {
      const actor = await actorOf(c);
      const hasBody = (await c.req.raw.clone().text()).trim() !== "";
      const input = hasBody ? await readJsonBody(c.req.raw, "Credential") : {};
      const rotated = await services.rotateAccessCredentialUseCase.execute(actor, scopeOf(c), c.req.param("credentialId"), input);
      c.header("Cache-Control", "no-store");
      return c.json(rotated, 201);
    });
    app.delete(`${path}/:credentialId`, async (c) => {
      const actor = await actorOf(c);
      const credential = await services.revokeAccessCredentialUseCase.execute(actor, scopeOf(c), c.req.param("credentialId"));
      return c.json({ credential });
    });
  };
  credentialRoutes("project");
  credentialRoutes("workspace");
};
