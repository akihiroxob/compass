import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentPrincipalOf, type HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * S06-03: Credentialは明示scope（Workspace / Project）に束縛する。Workspace CredentialはWorkspace scopeの
 * Direction Role・Runtimeだけ、Project CredentialはProject scopeのWork・Runtimeだけで認可し、互いに転用できない。
 */

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });
const code = (expected: string, details?: Record<string, string>) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  if (details) assert.deepEqual((error as { details?: Record<string, string> }).details, details);
  return true;
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  let now = Date.UTC(2026, 0, 1);
  const services = createApplicationServices(database, undefined, () => now);
  const webApp = createApp(services);
  const remoteApp = createApp(services, { humanAuth: { mode: "remote", publicOrigin: "https://compass.example" } });
  const owner = await createTestHuman(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const other = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const project = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha app" });
  return {
    database,
    services,
    webApp,
    remoteApp,
    owner,
    workspace,
    other,
    project,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

const credentialsPath = (kind: "workspaces" | "projects", id: string) => `/api/${kind}/${id}/credentials`;

const issue = (app: App, human: TestHuman, path: string, body: object) =>
  requestAs(app, human)(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const issueToken = async (app: App, human: TestHuman, path: string, body: object) => {
  const response = await issue(app, human, path, body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { credential: Json; token: string };
};

const callTool = async (app: App, token: string, name: string, args: object) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result as { isError?: boolean; structuredContent: Json };
};

test("Workspace Credentialは新規DBへscope付きで保存し、Workspace AdministratorだけがWorkspaceの入口で管理できる", async () => {
  const { database, services, webApp, owner, workspace, other, project } = await setup();
  try {
    const workspacePath = credentialsPath("workspaces", workspace.id);
    const response = await issue(webApp, owner, workspacePath, { kind: "runtime", principalId: "orchestrator-a", scopes: ["runtime:state:read"] });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const { credential, token } = (await response.json()) as { credential: Json; token: string };
    assert.deepEqual(credential.scope, { kind: "workspace", id: workspace.id });
    assert.equal("projectId" in credential || "secretHash" in credential, false);
    const agent = await issueToken(webApp, owner, workspacePath, { kind: "agent", principalId: "strategist-a" });
    const projectCredential = await issueToken(webApp, owner, credentialsPath("projects", project.id), {
      kind: "runtime",
      principalId: "orchestrator-p",
      scopes: ["runtime:state:read"],
    });
    assert.deepEqual(projectCredential.credential.scope, { kind: "project", id: project.id });

    // scopeに対応するIDの列だけを保存し、secretの平文はどこにも残らない。
    const rows = await database.selectFrom("access_credential").select(["id", "scope_kind", "workspace_id", "project_id", "secret_hash"]).execute();
    assert.deepEqual(
      rows.map(({ scope_kind, workspace_id, project_id }) => [scope_kind, workspace_id, project_id]).sort(),
      [["project", null, project.id], ["workspace", workspace.id, null], ["workspace", workspace.id, null]],
    );
    for (const secret of [token, agent.token, projectCredential.token].map((value) => value.split(".")[2])) {
      assert.equal(JSON.stringify(rows).includes(secret), false);
    }

    // 一覧はscopeごとに分かれ、Workspaceの一覧に所属ProjectのCredentialは含めない（逆も同じ）。
    const listed = (await (await requestAs(webApp, owner)(workspacePath)).json()) as Json;
    assert.deepEqual(listed.credentials.map((item: Json) => item.principalId).sort(), ["orchestrator-a", "strategist-a"]);
    const projectListed = (await (await requestAs(webApp, owner)(credentialsPath("projects", project.id))).json()) as Json;
    assert.deepEqual(projectListed.credentials.map((item: Json) => item.principalId), ["orchestrator-p"]);
    assert.equal(((await (await requestAs(webApp, owner)(credentialsPath("workspaces", other.id))).json()) as Json).credentials.length, 0);

    // 別scopeのCredential IDはWorkspaceの入口から変更できない（404）。rotation・取消は同じscopeで行える。
    const crossScope = await requestAs(webApp, owner)(`${workspacePath}/${projectCredential.credential.id}`, { method: "DELETE" });
    assert.equal(crossScope.status, 404);
    const otherWorkspace = await requestAs(webApp, owner)(`${credentialsPath("workspaces", other.id)}/${credential.id}/rotate`, { method: "POST" });
    assert.equal(otherWorkspace.status, 404);
    const rotated = await requestAs(webApp, owner)(`${workspacePath}/${credential.id}/rotate`, { method: "POST" });
    assert.equal(rotated.status, 201);
    assert.deepEqual(((await rotated.json()) as Json).credential.scope, { kind: "workspace", id: workspace.id });
    const revoked = await requestAs(webApp, owner)(`${workspacePath}/${agent.credential.id}`, { method: "DELETE" });
    assert.equal(revoked.status, 200);
    assert.notEqual(((await revoked.json()) as Json).credential.revokedAt, null);

    // Workspace editorは管理できず、Project ownerでもWorkspace Membershipが無ければ404（Membershipを継承しない）。
    const editor = await createTestHuman(database, { email: "editor@example.com" });
    await addTestMembership(database, project.id, editor, "viewer");
    await services.human.addWorkspaceMember.execute(actorOf(owner), workspace.id, { humanUserId: editor.humanUserId, role: "editor" });
    const denied = await issue(webApp, editor, workspacePath, { kind: "agent", principalId: "x" });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as Json).error.requiredRole, "administrator");
    const projectOnly = await createTestHuman(database, { email: "project-only@example.com" });
    await addTestMembership(database, project.id, projectOnly, "owner");
    assert.equal((await requestAs(webApp, projectOnly)(workspacePath)).status, 404);
    await assert.rejects(
      services.issueAccessCredentialUseCase.execute(actorOf(editor), { kind: "workspace", id: workspace.id }, { kind: "invalid" }),
      code("FORBIDDEN", { requiredRole: "administrator", workspaceId: workspace.id }),
    );
  } finally {
    await database.destroy();
  }
});

test("Workspace Agent CredentialはWorkspace Direction Roleだけを認証し、所属ProjectのWorkやRuntimeへ転用できない", async () => {
  const { database, services, webApp, remoteApp, owner, workspace, other, project } = await setup();
  try {
    await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "strategist-a", role: "strategist" });
    const { token } = await issueToken(webApp, owner, credentialsPath("workspaces", workspace.id), { kind: "agent", principalId: "strategist-a" });
    const caller = await services.authenticateAccessCredentialUseCase.execute(token);
    assert.deepEqual(caller, {
      kind: "agent",
      credentialId: token.split(".")[1],
      scope: { kind: "workspace", id: workspace.id },
      principalId: "strategist-a",
    });
    const principal = agentPrincipalOf(caller);
    const authorization = services.roleScopeAuthorizationService.forActiveRole("strategist");
    assert.equal(await authorization.requireRole(principal, { kind: "workspace", id: workspace.id }, "strategist"), "strategist-a");
    // 別Workspace・Project scope・Grantの無いRoleは拒否する。
    await assert.rejects(authorization.requireRole(principal, { kind: "workspace", id: other.id }, "strategist"), code("FORBIDDEN"));
    await assert.rejects(authorization.requireRole(principal, { kind: "project", id: project.id }, "manager"), code("FORBIDDEN"));
    await assert.rejects(services.roleScopeAuthorizationService.requireRole(principal, { kind: "workspace", id: workspace.id }, "evaluator"), code("FORBIDDEN"));

    // 所属ProjectのWork toolとRuntime入口には使えない。
    const tasks = await callTool(remoteApp, token, "list_tasks", { projectId: project.id });
    assert.equal(tasks.structuredContent.error.code, "FORBIDDEN");
    const events = await remoteApp.request(`/api/workspaces/${workspace.id}/runtime-events`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(events.status, 403);
    await assert.rejects(services.runtimeAuthorizationService.requireWorkspaceScope(caller, workspace.id, "runtime:state:read"), code("FORBIDDEN"));
  } finally {
    await database.destroy();
  }
});

test("Runtime Credentialは発行scopeと操作scopeが一致し、必要なscopeを持つ場合だけ認可する", async () => {
  const { database, services, webApp, remoteApp, owner, workspace, other, project } = await setup();
  try {
    const workspaceRuntime = await issueToken(webApp, owner, credentialsPath("workspaces", workspace.id), {
      kind: "runtime",
      principalId: "orchestrator-w",
      scopes: ["runtime:event:read", "runtime:state:read"],
    });
    const projectRuntime = await issueToken(webApp, owner, credentialsPath("projects", project.id), {
      kind: "runtime",
      principalId: "orchestrator-p",
      scopes: ["runtime:event:read", "runtime:state:read"],
    });
    const runtime = services.runtimeAuthorizationService;
    const workspaceCaller = await services.authenticateAccessCredentialUseCase.execute(workspaceRuntime.token);
    const projectCaller = await services.authenticateAccessCredentialUseCase.execute(projectRuntime.token);

    assert.equal(await runtime.requireWorkspaceScope(workspaceCaller, workspace.id, "runtime:state:read"), "orchestrator-w");
    await assert.rejects(
      runtime.requireWorkspaceScope(workspaceCaller, workspace.id, "runtime:event:ack"),
      code("FORBIDDEN", { workspaceId: workspace.id, requiredScope: "runtime:event:ack" }),
    );
    await assert.rejects(runtime.requireWorkspaceScope(workspaceCaller, other.id, "runtime:state:read"), code("FORBIDDEN"));
    // WorkspaceとProjectの間で継承しない（所属Projectでも別scope）。
    await assert.rejects(
      runtime.requireScope(workspaceCaller, project.id, "runtime:state:read"),
      code("FORBIDDEN", { projectId: project.id, requiredScope: "runtime:state:read" }),
    );
    await assert.rejects(runtime.requireWorkspaceScope(projectCaller, workspace.id, "runtime:state:read"), code("FORBIDDEN"));
    assert.equal(await runtime.requireScope(projectCaller, project.id, "runtime:state:read"), "orchestrator-p");
    // trusted-localのAgent名・認証なしはWorkspace Runtimeを使えない。
    await assert.rejects(runtime.requireWorkspaceScope("orchestrator-w", workspace.id, "runtime:state:read"), code("FORBIDDEN"));
    await assert.rejects(runtime.requireWorkspaceScope(null, workspace.id, "runtime:state:read"), code("UNAUTHENTICATED"));

    // Workspace所有のRuntime event入口は、Workspace Runtime Credentialだけを受け付ける（Project Credentialから継承しない）。
    const headers = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await remoteApp.request(`/api/workspaces/${workspace.id}/runtime-events`, headers(workspaceRuntime.token))).status, 200);
    const denied = await remoteApp.request(`/api/workspaces/${workspace.id}/runtime-events`, headers(projectRuntime.token));
    assert.equal(denied.status, 403);
    assert.equal(JSON.stringify(await denied.json()).includes(projectRuntime.token.split(".")[2]), false);
    const state = await callTool(remoteApp, workspaceRuntime.token, "get_orchestration_state", { projectId: project.id });
    assert.equal(state.structuredContent.error.code, "FORBIDDEN");
  } finally {
    await database.destroy();
  }
});

test("Agent Principalは1つのscopeに束縛し、WorkspaceとProjectのGrant・Credentialを共有させない", async () => {
  const { database, services, webApp, owner, workspace, other, project } = await setup();
  try {
    const workspacePath = credentialsPath("workspaces", workspace.id);
    const projectPath = credentialsPath("projects", project.id);
    const conflict = async (response: Response) => {
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as Json).error.conflict, "PRINCIPAL_BOUND_ELSEWHERE");
    };

    // Workspace Credentialに束縛したPrincipalは、所属Project・別WorkspaceのGrantとCredentialを得られない。
    await issueToken(webApp, owner, workspacePath, { kind: "agent", principalId: "strategist-a" });
    await assert.rejects(
      services.grantProjectRoleUseCase.execute(project.id, { principalId: "strategist-a", role: "manager" }),
      code("CONFLICT"),
    );
    await assert.rejects(
      services.grantWorkspaceRoleUseCase.execute(other.id, { principalId: "strategist-a", role: "strategist" }),
      code("CONFLICT"),
    );
    await conflict(await issue(webApp, owner, projectPath, { kind: "agent", principalId: "strategist-a" }));
    await conflict(await issue(webApp, owner, credentialsPath("workspaces", other.id), { kind: "agent", principalId: "strategist-a" }));
    // 同じWorkspaceのGrantは付与できる。
    assert.equal((await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "strategist-a", role: "strategist" })).created, true);

    // Project Credentialに束縛したPrincipalは、WorkspaceのGrantとCredentialを得られない。
    await issueToken(webApp, owner, projectPath, { kind: "agent", principalId: "manager-p" });
    await assert.rejects(
      services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: "manager-p", role: "strategist" }),
      code("CONFLICT"),
    );
    await conflict(await issue(webApp, owner, workspacePath, { kind: "agent", principalId: "manager-p" }));

    // 別scopeのGrantを持つPrincipalにはAgent Credentialを発行しない。Runtime CredentialはGrantを使わないため束縛しない。
    await services.grantWorkspaceRoleUseCase.execute(other.id, { principalId: "researcher-b", role: "researcher" });
    await conflict(await issue(webApp, owner, workspacePath, { kind: "agent", principalId: "researcher-b" }));
    await conflict(await issue(webApp, owner, projectPath, { kind: "agent", principalId: "researcher-b" }));
    await services.grantProjectRoleUseCase.execute(project.id, { principalId: "worker-p", role: "worker" });
    await conflict(await issue(webApp, owner, workspacePath, { kind: "agent", principalId: "worker-p" }));
    assert.equal((await issue(webApp, owner, workspacePath, { kind: "runtime", principalId: "worker-p", scopes: ["runtime:state:read"] })).status, 201);
  } finally {
    await database.destroy();
  }
});

test("期限切れ・取消済みのWorkspace Credentialは認証せず、archivedのWorkspaceでは発行・rotationだけを拒否する", async () => {
  const { database, services, webApp, owner, workspace, advance } = await setup();
  try {
    const workspacePath = credentialsPath("workspaces", workspace.id);
    const short = await issueToken(webApp, owner, workspacePath, { kind: "runtime", principalId: "rt-short", scopes: ["runtime:state:read"], expiresInDays: 1 });
    const revoked = await issueToken(webApp, owner, workspacePath, { kind: "agent", principalId: "rt-revoked" });
    const kept = await issueToken(webApp, owner, workspacePath, { kind: "runtime", principalId: "rt-kept", scopes: ["runtime:state:read"] });
    assert.equal((await requestAs(webApp, owner)(`${workspacePath}/${revoked.credential.id}`, { method: "DELETE" })).status, 200);
    advance(24 * 60 * 60 * 1000);
    for (const token of [short.token, revoked.token]) {
      await assert.rejects(services.authenticateAccessCredentialUseCase.execute(token), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UNAUTHENTICATED");
        assert.equal(String((error as Error).message).includes(token.split(".")[2]), false);
        return true;
      });
    }

    await services.human.archiveWorkspace.execute(actorOf(owner), workspace.id, { reason: "done" });
    assert.equal((await issue(webApp, owner, workspacePath, { kind: "agent", principalId: "late" })).status, 409);
    assert.equal((await requestAs(webApp, owner)(`${workspacePath}/${kept.credential.id}/rotate`, { method: "POST" })).status, 409);
    assert.equal((await requestAs(webApp, owner)(`${workspacePath}/${kept.credential.id}`, { method: "DELETE" })).status, 200);
  } finally {
    await database.destroy();
  }
});

test("新規file DBのWorkspace / Project Credentialは同じschemaの再初期化後もscopeを保持し、scopeとIDの不一致はDBが拒否する", async () => {
  const path = join(tmpdir(), `compass-workspace-credential-${process.pid}-${Date.now()}.db`);
  try {
    const first = await setup(path);
    const workspaceToken = await issueToken(first.webApp, first.owner, credentialsPath("workspaces", first.workspace.id), {
      kind: "runtime",
      principalId: "rt-w",
      scopes: ["runtime:state:read"],
    });
    const projectToken = await issueToken(first.webApp, first.owner, credentialsPath("projects", first.project.id), {
      kind: "runtime",
      principalId: "rt-p",
      scopes: ["runtime:state:read"],
    });
    await first.database.destroy();

    const database = createDatabase(path);
    try {
      await initializeSchema(database);
      const services = createApplicationServices(database, undefined, () => Date.UTC(2026, 0, 2));
      assert.deepEqual((await services.authenticateAccessCredentialUseCase.execute(workspaceToken.token)).scope, {
        kind: "workspace",
        id: first.workspace.id,
      });
      assert.deepEqual((await services.authenticateAccessCredentialUseCase.execute(projectToken.token)).scope, {
        kind: "project",
        id: first.project.id,
      });
      const row = await database.selectFrom("access_credential").selectAll().where("id", "=", workspaceToken.credential.id).executeTakeFirstOrThrow();
      for (const invalid of [
        { scope_kind: "workspace" as const, workspace_id: null, project_id: null },
        { scope_kind: "workspace" as const, workspace_id: first.workspace.id, project_id: first.project.id },
        { scope_kind: "project" as const, workspace_id: first.workspace.id, project_id: null },
      ]) {
        await assert.rejects(
          database.insertInto("access_credential").values({ ...row, ...invalid, id: crypto.randomUUID(), secret_hash: crypto.randomUUID() }).execute(),
          /CHECK constraint failed/,
        );
      }
      await assert.rejects(
        database
          .insertInto("access_credential")
          .values({ ...row, workspace_id: "missing", id: crypto.randomUUID(), secret_hash: crypto.randomUUID() })
          .execute(),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      await database.destroy();
    }
  } finally {
    await rm(path, { force: true });
  }
});
