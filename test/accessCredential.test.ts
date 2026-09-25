import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * Task 37: Agent・Runtime用の不透明Credential。発行・rotation・取消はHuman（Administrator以上）のWeb API、
 * 利用はremote modeの`/mcp`とRuntime向けAPI。Human SessionとCredentialの経路を混同しないことを確認する。
 */

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  let now = Date.UTC(2026, 0, 1);
  const clock = () => now;
  const services = createApplicationServices(database, undefined, clock);
  // Human向けWeb API（Session Cookie）はtrusted-localのCookie名で呼ぶ。MCP・Runtime向けAPIはremote modeで検証する。
  const webApp = createApp(services);
  const remoteApp = createApp(services, { humanAuth: { mode: "remote", publicOrigin: "https://compass.example" } });
  const localApp = createApp(services, { humanAuth: { mode: "trusted-local", publicOrigin: "http://localhost" } });
  const project = await services.createProjectUseCase.execute({ name: "Alpha", mission: "M" });
  const other = await services.createProjectUseCase.execute({ name: "Beta", mission: "M" });
  const owner = await createTestHuman(database);
  await addTestMembership(database, project.id, owner, "owner");
  await addTestMembership(database, other.id, owner, "owner");
  return {
    database,
    services,
    webApp,
    remoteApp,
    localApp,
    project,
    other,
    owner,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

const issue = async (app: App, human: TestHuman, projectId: string, body: object) =>
  requestAs(app, human)(`/api/projects/${projectId}/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const issueToken = async (app: App, human: TestHuman, projectId: string, body: object) => {
  const response = await issue(app, human, projectId, body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { credential: Json; token: string };
};

const mcp = async (app: App, method: string, params: object, authorization?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (response.status !== 200) return { status: response.status, body: (await response.json()) as Json };
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return { status: 200, body: JSON.parse(data.slice(6)) as Json };
};

const callTool = async (app: App, token: string, name: string, args: object) => {
  const reply = await mcp(app, "tools/call", { name, arguments: args }, `Bearer ${token}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.result as { isError?: boolean; structuredContent: Json };
};

const runtimeEvents = (app: App, projectId: string, token: string) =>
  app.request(`/api/projects/${projectId}/runtime-events`, { headers: { Authorization: `Bearer ${token}` } });

test("Administrator以上がCredentialを発行でき、secretは一度だけ返りDBにはhashだけが残る", async () => {
  const { database, webApp, project, owner } = await setup();
  const response = await issue(webApp, owner, project.id, { kind: "runtime", principalId: "runtime-a", scopes: ["runtime:event:read"] });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { credential, token } = (await response.json()) as { credential: Json; token: string };
  assert.match(token, /^cmp_runtime\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.kind, "runtime");
  assert.equal(credential.principalId, "runtime-a");
  assert.deepEqual(credential.scopes, ["runtime:event:read"]);
  assert.equal(credential.prefix, `cmp_runtime.${credential.id.slice(0, 8)}`);
  assert.equal("secretHash" in credential, false);
  assert.equal(JSON.stringify(credential).includes(token.split(".")[2]), false);

  // 一覧はsecret・hashを含まない。
  const listed = (await (await requestAs(webApp, owner)(`/api/projects/${project.id}/credentials`)).json()) as Json;
  assert.equal(listed.credentials.length, 1);
  assert.equal(JSON.stringify(listed).includes(token.split(".")[2]), false);
  assert.equal("secretHash" in listed.credentials[0], false);

  // DBのどのtableにもsecretの平文は無い（hashだけ）。
  const secret = token.split(".")[2];
  const row = await database.selectFrom("access_credential").selectAll().executeTakeFirstOrThrow();
  assert.notEqual(row.secret_hash, secret);
  assert.match(row.secret_hash, /^[0-9a-f]{64}$/);
  const tables = ["access_credential", "change_log", "runtime_event", "project_grant"] as const;
  for (const table of tables) {
    const rows = await database.selectFrom(table).selectAll().execute();
    assert.equal(JSON.stringify(rows).includes(secret), false, table);
  }
});

test("editor・viewer・未所属・Sessionなしは発行・一覧・取消できない", async () => {
  const { database, webApp, project, owner } = await setup();
  const { credential } = await issueToken(webApp, owner, project.id, { kind: "agent", principalId: "worker-a" });
  const administrator = await createTestHuman(database);
  await addTestMembership(database, project.id, administrator, "administrator");
  assert.equal((await issue(webApp, administrator, project.id, { kind: "agent", principalId: "worker-b" })).status, 201);

  for (const role of ["editor", "viewer"] as const) {
    const human = await createTestHuman(database);
    await addTestMembership(database, project.id, human, role);
    assert.equal((await issue(webApp, human, project.id, { kind: "agent", principalId: "x" })).status, 403);
    assert.equal((await requestAs(webApp, human)(`/api/projects/${project.id}/credentials`)).status, 403);
    const revoke = await requestAs(webApp, human)(`/api/projects/${project.id}/credentials/${credential.id}`, { method: "DELETE" });
    assert.equal(revoke.status, 403);
  }
  const outsider = await createTestHuman(database);
  assert.equal((await issue(webApp, outsider, project.id, { kind: "agent", principalId: "x" })).status, 404);
  const anonymous = await webApp.request(`/api/projects/${project.id}/credentials`);
  assert.equal(anonymous.status, 401);
  // Agent・RuntimeのCredentialでHuman向けAPIは使えない（Session Cookieだけで認可する）。
  const { token } = await issueToken(webApp, owner, project.id, { kind: "runtime", principalId: "rt", scopes: ["runtime:event:read"] });
  const withBearer = await webApp.request(`/api/projects/${project.id}/credentials`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(withBearer.status, 401);
});

test("入力を検証する: 種別・scope・期限", async () => {
  const { webApp, project, owner } = await setup();
  const invalid = [
    { kind: "human", principalId: "a" },
    { kind: "agent", principalId: "a", scopes: ["runtime:event:read"] },
    { kind: "runtime", principalId: "a" },
    { kind: "runtime", principalId: "a", scopes: ["admin"] },
    { kind: "agent", principalId: "", expiresInDays: 1 },
    { kind: "agent", principalId: "a", expiresInDays: 366 },
  ];
  for (const body of invalid) {
    const response = await issue(webApp, owner, project.id, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("remote modeのAgent CredentialはPrincipalへ解決し、Project GrantとGrantの有るProjectだけで認可する", async () => {
  const { services, webApp, remoteApp, project, other, owner } = await setup();
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "strategist-a", role: "strategist" });
  const { token } = await issueToken(webApp, owner, project.id, { kind: "agent", principalId: "strategist-a" });

  const listed = await callTool(remoteApp, token, "list_projects", {});
  assert.deepEqual(listed.structuredContent.projects.map((item: Json) => item.id), [project.id]);
  assert.notEqual((await callTool(remoteApp, token, "get_project", { projectId: project.id })).isError, true);
  assert.notEqual((await callTool(remoteApp, token, "get_strategist_context", { projectId: project.id })).isError, true);

  // Grantの無いProject・Grantの無いRoleはFORBIDDEN。
  const foreign = await callTool(remoteApp, token, "get_project", { projectId: other.id });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.structuredContent.error.code, "FORBIDDEN");
  const noRole = await callTool(remoteApp, token, "get_evaluator_context", { projectId: project.id, outcomeId: "x" });
  assert.equal(noRole.structuredContent.error.code, "FORBIDDEN");

  // Agent CredentialでRuntime向けの操作はできない（種別違い）。
  const runtimeTool = await callTool(remoteApp, token, "fetch_runtime_events", { projectId: project.id });
  assert.equal(runtimeTool.structuredContent.error.code, "FORBIDDEN");
  assert.equal((await runtimeEvents(remoteApp, project.id, token)).status, 403);

  // Grantを取り消すと次の呼出しから拒否される。
  await services.revokeProjectRoleUseCase.execute(project.id, { principalId: "strategist-a", role: "strategist" });
  const revokedGrant = await callTool(remoteApp, token, "get_project", { projectId: project.id });
  assert.equal(revokedGrant.structuredContent.error.code, "FORBIDDEN");
});

test("Runtime Credentialは明示scopeと発行Projectだけで認可し、Agent向けtoolは使えない", async () => {
  const { services, webApp, remoteApp, project, other, owner } = await setup();
  await services.createIntentUseCase.execute(project.id, { title: "I", desiredState: "S" });
  const { token } = await issueToken(webApp, owner, project.id, {
    kind: "runtime",
    principalId: "runtime-a",
    scopes: ["runtime:event:read", "runtime:event:ack", "execution:change:read"],
  });

  const fetched = await runtimeEvents(remoteApp, project.id, token);
  assert.equal(fetched.status, 200);
  const { events } = (await fetched.json()) as Json;
  assert.equal(events[0].type, "research_requested");
  const ack = await remoteApp.request(`/api/projects/${project.id}/runtime-events/${events[0].id}/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: "a-1", outcome: "processed" }),
  });
  assert.equal(ack.status, 200);
  const changes = await callTool(remoteApp, token, "list_changes", { projectId: project.id });
  assert.notEqual(changes.isError, true, JSON.stringify(changes));

  // scope不足・別ProjectはFORBIDDEN。
  const evidence = await remoteApp.request(`/api/projects/${project.id}/outcomes/o-1/execution-evidence`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ changeCursor: 0 }),
  });
  assert.equal(evidence.status, 403);
  assert.equal(((await evidence.json()) as Json).error.requiredScope, "execution:evidence:write");
  const summary = await callTool(remoteApp, token, "get_outcome_execution_summary", { projectId: project.id, outcomeId: "o" });
  assert.equal(summary.structuredContent.error.code, "FORBIDDEN");
  assert.equal((await runtimeEvents(remoteApp, other.id, token)).status, 403);

  // Runtime CredentialはRole Grantの経路を使えない（Agent向けtoolではPrincipalなし）。
  const agentTool = await callTool(remoteApp, token, "get_project", { projectId: project.id });
  assert.equal(agentTool.structuredContent.error.code, "UNAUTHENTICATED");
  const workerTool = await callTool(remoteApp, token, "list_tasks", { projectId: project.id });
  assert.equal(workerTool.structuredContent.error.code, "UNAUTHENTICATED");
});

test("期限切れ・取消済み・改ざん・未知ID・種別違いのtokenはUNAUTHENTICATEDで、tokenを応答に含めない", async () => {
  const { webApp, remoteApp, project, owner, advance } = await setup();
  const runtime = await issueToken(webApp, owner, project.id, {
    kind: "runtime",
    principalId: "runtime-a",
    scopes: ["runtime:event:read"],
    expiresInDays: 1,
  });
  const [, id, secret] = runtime.token.split(".");
  const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
  const cases = [
    `cmp_runtime.${id}.${flipped}`,
    `cmp_runtime.00000000-0000-4000-8000-000000000000.${secret}`,
    `cmp_agent.${id}.${secret}`,
    "cmp_runtime.garbage",
  ];
  for (const token of cases) {
    const response = await runtimeEvents(remoteApp, project.id, token);
    assert.equal(response.status, 401, token);
    const text = await response.text();
    assert.equal(text.includes(secret), false);
    const reply = await mcp(remoteApp, "tools/list", {}, `Bearer ${token}`);
    assert.equal(reply.status, 401);
    assert.equal(JSON.stringify(reply.body).includes(secret), false);
  }
  assert.equal((await runtimeEvents(remoteApp, project.id, runtime.token)).status, 200);

  // 取消は次の呼出しから反映される。
  const revoked = await requestAs(webApp, owner)(`/api/projects/${project.id}/credentials/${runtime.credential.id}`, {
    method: "DELETE",
  });
  assert.equal(revoked.status, 200);
  assert.equal((await runtimeEvents(remoteApp, project.id, runtime.token)).status, 401);
  // 取消は冪等。
  const again = await requestAs(webApp, owner)(`/api/projects/${project.id}/credentials/${runtime.credential.id}`, {
    method: "DELETE",
  });
  assert.equal(((await again.json()) as Json).credential.revokedAt, ((await revoked.json()) as Json).credential.revokedAt);

  // 期限切れ。
  const expiring = await issueToken(webApp, owner, project.id, {
    kind: "runtime",
    principalId: "runtime-b",
    scopes: ["runtime:event:read"],
    expiresInDays: 1,
  });
  assert.equal((await runtimeEvents(remoteApp, project.id, expiring.token)).status, 200);
  advance(24 * 60 * 60 * 1000);
  assert.equal((await runtimeEvents(remoteApp, project.id, expiring.token)).status, 401);
});

test("rotation中は期限付きで新旧Credentialを併用でき、猶予後は旧Credentialを拒否する", async () => {
  const { webApp, remoteApp, project, owner, advance } = await setup();
  const original = await issueToken(webApp, owner, project.id, {
    kind: "runtime",
    principalId: "runtime-a",
    scopes: ["runtime:event:read"],
  });
  const rotate = (credentialId: string, body: object) =>
    requestAs(webApp, owner)(`/api/projects/${project.id}/credentials/${credentialId}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await rotate(original.credential.id, { graceHours: 2 });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const rotated = (await response.json()) as { credential: Json; token: string; previous: Json };
  assert.notEqual(rotated.token, original.token);
  assert.match(rotated.token, /^cmp_runtime\./);
  assert.equal(rotated.credential.rotatedFromId, original.credential.id);
  assert.equal(rotated.credential.principalId, "runtime-a");
  assert.deepEqual(rotated.credential.scopes, ["runtime:event:read"]);

  assert.equal((await runtimeEvents(remoteApp, project.id, original.token)).status, 200);
  assert.equal((await runtimeEvents(remoteApp, project.id, rotated.token)).status, 200);
  advance(2 * 60 * 60 * 1000);
  assert.equal((await runtimeEvents(remoteApp, project.id, original.token)).status, 401);
  assert.equal((await runtimeEvents(remoteApp, project.id, rotated.token)).status, 200);

  // 期限切れ・取消済みはrotationできない。
  assert.equal((await rotate(original.credential.id, {})).status, 409);
  assert.equal((await rotate("00000000-0000-4000-8000-000000000000", {})).status, 404);
});

test("remote modeではAgent名だけのBearerをtrusted-localへ降格せず拒否し、trusted-localでは従来どおり受け付ける", async () => {
  const { services, remoteApp, localApp, project } = await setup();
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "runtime-a", role: "runtime" });
  const remoteMcp = await mcp(remoteApp, "tools/list", {}, "Bearer runtime-a");
  assert.equal(remoteMcp.status, 401);
  assert.equal(remoteMcp.body.error.code, -32001);
  assert.equal((await runtimeEvents(remoteApp, project.id, "runtime-a")).status, 401);

  assert.equal((await mcp(localApp, "tools/list", {}, "Bearer runtime-a")).status, 200);
  assert.equal((await runtimeEvents(localApp, project.id, "runtime-a")).status, 200);
  // trusted-localでもCredential形式のBearerはAgent名として扱わず、検証に失敗すれば拒否する。
  assert.equal((await runtimeEvents(localApp, project.id, "cmp_runtime.invalid")).status, 401);
});

test("Agent Credentialは発行Projectに束縛し、別ProjectのGrant・Credentialと同じPrincipalを共有させない", async () => {
  const { services, webApp, project, other, owner } = await setup();
  await services.grantProjectRoleUseCase.execute(other.id, { principalId: "shared", role: "worker" });
  const bound = await issue(webApp, owner, project.id, { kind: "agent", principalId: "shared" });
  assert.equal(bound.status, 409);
  assert.equal(((await bound.json()) as Json).error.conflict, "PRINCIPAL_BOUND_ELSEWHERE");

  await issueToken(webApp, owner, project.id, { kind: "agent", principalId: "alpha-worker" });
  const second = await issue(webApp, owner, other.id, { kind: "agent", principalId: "alpha-worker" });
  assert.equal(second.status, 409);
  const grant = await requestAs(webApp, owner)(`/api/projects/${other.id}/grants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principalId: "alpha-worker", role: "worker" }),
  });
  assert.equal(grant.status, 409);
  // 同じProject内のGrantは従来どおり。
  const sameProject = await requestAs(webApp, owner)(`/api/projects/${project.id}/grants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principalId: "alpha-worker", role: "worker" }),
  });
  assert.equal(sameProject.status, 201);
  // Runtime CredentialはRole Grantを使わないため束縛しない。
  assert.equal((await issue(webApp, owner, project.id, { kind: "runtime", principalId: "shared", scopes: ["runtime:event:read"] })).status, 201);
});

test("archivedのProjectでは発行・rotationを拒否し、取消はできる。再起動後もCredentialの状態を保持する", async () => {
  const path = `/tmp/compass-credential-${process.pid}-${Date.now()}.db`;
  const first = createDatabase(path);
  await initializeSchema(first);
  const services = createApplicationServices(first);
  const webApp = createApp(services);
  const project = await services.createProjectUseCase.execute({ name: "Alpha", mission: "M" });
  const owner = await createTestHuman(first);
  await addTestMembership(first, project.id, owner, "owner");
  const kept = await issueToken(webApp, owner, project.id, { kind: "runtime", principalId: "rt", scopes: ["runtime:event:read"] });
  const toRevoke = await issueToken(webApp, owner, project.id, { kind: "runtime", principalId: "rt2", scopes: ["runtime:event:read"] });
  await services.archiveProjectUseCase.execute(project.id, { reason: "done" });

  assert.equal((await issue(webApp, owner, project.id, { kind: "agent", principalId: "a" })).status, 409);
  const rotate = await requestAs(webApp, owner)(`/api/projects/${project.id}/credentials/${kept.credential.id}/rotate`, {
    method: "POST",
  });
  assert.equal(rotate.status, 409);
  const revoke = await requestAs(webApp, owner)(`/api/projects/${project.id}/credentials/${toRevoke.credential.id}`, {
    method: "DELETE",
  });
  assert.equal(revoke.status, 200);
  await first.destroy();

  const second = createDatabase(path);
  await initializeSchema(second);
  const restarted = createApp(createApplicationServices(second), {
    humanAuth: { mode: "remote", publicOrigin: "https://compass.example" },
  });
  assert.equal((await runtimeEvents(restarted, project.id, kept.token)).status, 200);
  assert.equal((await runtimeEvents(restarted, project.id, toRevoke.token)).status, 401);
  await second.destroy();
});
