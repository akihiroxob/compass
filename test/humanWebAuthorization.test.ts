import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { ForbiddenError } from "../src/application/error/ForbiddenError.ts";
import { NotFoundError } from "../src/application/error/NotFoundError.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { humanProjectPermissions, humanRoles, type HumanRole } from "../src/domain/model/HumanAuth.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, humanHeaders, requestAs, testSessionCookie, type TestHuman } from "./support/humanSession.ts";

/**
 * Task 42: 既存のHuman向けWeb APIへSession・Project Membership認可を適用する
 * （docs/step-6-human-auth-design.md「権限表（Human Role）」「認可の順序と応答」）。
 */

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = createApp(services);
  return { database, services, app };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const json = async (response: Response) => (await response.json()) as Record<string, any>;

const send = (ctx: Setup, human: TestHuman, method: string, path: string, body?: unknown) =>
  requestAs(ctx.app, human)(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** ownerがWeb APIでProjectを作り、各Roleのmemberを加える。 */
const seedProject = async (ctx: Setup, name = "Compass") => {
  const owner = await createTestHuman(ctx.database);
  const created = await send(ctx, owner, "POST", "/api/projects", { name, mission: "Keep direction explicit" });
  assert.equal(created.status, 201);
  const project = (await json(created)).project as { id: string };
  const members = { owner } as Record<HumanRole, TestHuman>;
  for (const role of ["administrator", "editor", "viewer"] as const) {
    members[role] = await createTestHuman(ctx.database);
    await addTestMembership(ctx.database, project.id, members[role], role);
  }
  const intent = (await json(await send(ctx, owner, "POST", `/api/projects/${project.id}/intents`, { title: "I", desiredState: "S" })))
    .intent as { id: string };
  const outcome = (
    await json(
      await send(ctx, owner, "POST", `/api/projects/${project.id}/intents/${intent.id}/outcomes`, {
        title: "O",
        description: "D",
        rationale: "R",
        successCriteria: [{ description: "C", measurement: "M" }],
      }),
    )
  ).outcome as { id: string };
  return { project, intent, outcome, members };
};

test("Project作成者はowner Membershipになり、一覧は所属Projectだけ、詳細はmyRoleを返す", async () => {
  const ctx = await setup();
  const alpha = await seedProject(ctx, "Alpha");
  const beta = await seedProject(ctx, "Beta");
  // MCP・use caseで作られたowner不在のProjectは、だれの一覧にも出ない。
  await ctx.services.createProjectUseCase.execute({ name: "Orphan", mission: "m" });

  const names = async (human: TestHuman, query = "") =>
    ((await json(await send(ctx, human, "GET", `/api/projects${query}`))).projects as { name: string }[]).map((p) => p.name);
  assert.deepEqual(await names(alpha.members.owner), ["Alpha"]);
  assert.deepEqual(await names(beta.members.viewer), ["Beta"]);
  const both = await createTestHuman(ctx.database);
  await addTestMembership(ctx.database, alpha.project.id, both, "viewer");
  await addTestMembership(ctx.database, beta.project.id, both, "editor");
  assert.deepEqual((await names(both)).sort(), ["Alpha", "Beta"]);
  assert.deepEqual(await names(await createTestHuman(ctx.database)), []);

  // archivedの絞り込みも所属Projectだけ。
  assert.equal((await send(ctx, alpha.members.owner, "POST", `/api/projects/${alpha.project.id}/archive`, { reason: "done" })).status, 200);
  assert.deepEqual(await names(both, "?status=archived"), ["Alpha"]);
  assert.deepEqual(await names(beta.members.owner, "?status=archived"), []);

  for (const role of humanRoles) {
    const detail = await json(await send(ctx, beta.members[role], "GET", `/api/projects/${beta.project.id}`));
    assert.equal(detail.myRole, role);
    assert.equal(detail.project.id, beta.project.id);
  }
  const members = (await json(await send(ctx, beta.members.viewer, "GET", `/api/projects/${beta.project.id}/members`))).members as {
    membership: { role: string; humanUserId: string };
  }[];
  assert.equal(members.find((member) => member.membership.humanUserId === beta.members.owner.humanUserId)?.membership.role, "owner");
  await ctx.database.destroy();
});

test("各Roleは権限表で許可されたCommandだけが成功し、不足は403（requiredRole付き）で何も変えない", async () => {
  const ctx = await setup();
  const { project, intent, outcome, members } = await seedProject(ctx);
  const base = `/api/projects/${project.id}`;
  const outcomePath = `${base}/intents/${intent.id}/outcomes/${outcome.id}`;
  // [説明, method, path, body, 最低Role]。成功で状態が変わるCommandは、最低Roleで最後に実行する。
  const reads: [string, string][] = [
    ["project", base],
    ["intents", `${base}/intents`],
    ["intent", `${base}/intents/${intent.id}`],
    ["outcomes", `${base}/intents/${intent.id}/outcomes`],
    ["outcome", outcomePath],
    ["grants", `${base}/grants`],
    ["members", `${base}/members`],
    ["research", `${base}/research-requests`],
    ["decisions", `${base}/intents/${intent.id}/decisions`],
    ["adr", `${base}/adr-references`],
    ["execution summary", `${base}/outcomes/${outcome.id}/execution-summary`],
  ];
  for (const role of humanRoles) {
    for (const [label, path] of reads) {
      assert.equal((await send(ctx, members[role], "GET", path)).status, 200, `${role} ${label}`);
    }
  }

  const commands: { label: string; method: string; path: string; body?: unknown; minimum: HumanRole; ok: number }[] = [
    { label: "update intent", method: "PATCH", path: `${base}/intents/${intent.id}`, body: { title: "I2" }, minimum: "editor", ok: 200 },
    { label: "update outcome", method: "PATCH", path: outcomePath, body: { title: "O2" }, minimum: "editor", ok: 200 },
    { label: "update project", method: "PATCH", path: base, body: { description: "changed" }, minimum: "administrator", ok: 200 },
    { label: "grant", method: "POST", path: `${base}/grants`, body: { principalId: "agent-1", role: "strategist" }, minimum: "administrator", ok: 201 },
    { label: "revoke grant", method: "DELETE", path: `${base}/grants/strategist/agent-1`, minimum: "administrator", ok: 200 },
    { label: "list invitations", method: "GET", path: `${base}/invitations`, minimum: "owner", ok: 200 },
    { label: "invite", method: "POST", path: `${base}/invitations`, body: { email: "new@example.com", role: "viewer" }, minimum: "owner", ok: 201 },
  ];
  const rank = (role: HumanRole) => humanRoles.length - humanRoles.indexOf(role);
  for (const command of commands) {
    for (const role of [...humanRoles].reverse()) {
      if (rank(role) < rank(command.minimum)) {
        const denied = await send(ctx, members[role], command.method, command.path, command.body);
        assert.equal(denied.status, 403, `${role} ${command.label}`);
        const error = (await json(denied)).error;
        assert.equal(error.code, "FORBIDDEN");
        assert.equal(error.requiredRole, command.minimum);
      }
    }
    const allowed = await send(ctx, members[command.minimum], command.method, command.path, command.body);
    assert.equal(allowed.status, command.ok, `${command.minimum} ${command.label}: ${JSON.stringify(await json(allowed.clone()))}`);
  }
  // 拒否されたCommandは何も変えていない（Grantは発行後に取消され、招待はownerの1件だけ）。
  assert.equal((await json(await send(ctx, members.viewer, "GET", `${base}/grants`))).grants.length, 0);
  assert.equal((await json(await send(ctx, members.owner, "GET", `${base}/invitations`))).invitations.length, 1);
  assert.equal((await json(await send(ctx, members.viewer, "GET", base))).project.description, "changed");

  // archiveはownerだけ（不可逆）。
  for (const role of ["administrator", "editor", "viewer"] as const) {
    assert.equal((await send(ctx, members[role], "POST", `${base}/archive`, { reason: "x" })).status, 403, role);
  }
  assert.equal((await send(ctx, members.owner, "POST", `${base}/archive`, { reason: "done" })).status, 200);
  await ctx.database.destroy();
});

test("未所属・存在しないProject・別Projectの子ID・取消済みMembershipは一貫して404で、存在を漏らさない", async () => {
  const ctx = await setup();
  const alpha = await seedProject(ctx, "Alpha");
  const beta = await seedProject(ctx, "Beta");
  const outsider = alpha.members.owner;

  const notFound = async (human: TestHuman, method: string, path: string, body?: unknown) => {
    const response = await send(ctx, human, method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    return (await json(response)).error as { code: string; message: string };
  };
  // 存在するが未所属のProjectと、存在しないProjectは同じ形の404。入力が不正でも先に404。
  const hidden = await notFound(outsider, "GET", `/api/projects/${beta.project.id}`);
  const missing = await notFound(outsider, "GET", "/api/projects/missing");
  assert.equal(hidden.code, "NOT_FOUND");
  assert.equal(missing.code, "NOT_FOUND");
  assert.equal(hidden.message.replace(beta.project.id, "<id>"), missing.message.replace("missing", "<id>"));
  await notFound(outsider, "PATCH", `/api/projects/${beta.project.id}`, { name: "" });
  await notFound(outsider, "POST", `/api/projects/${beta.project.id}/intents`, { title: "x", desiredState: "S" });
  await notFound(outsider, "GET", `/api/projects/${beta.project.id}/intents/${beta.intent.id}`);
  await notFound(outsider, "GET", `/api/projects/${beta.project.id}/members`);
  await notFound(outsider, "POST", `/api/projects/${beta.project.id}/invitations`, { email: "x@example.com", role: "owner" });
  // 自分のProjectのURLに別Projectの子IDを混ぜても参照・変更できない（既存use caseの404）。
  await notFound(outsider, "GET", `/api/projects/${alpha.project.id}/intents/${beta.intent.id}`);
  await notFound(outsider, "PATCH", `/api/projects/${alpha.project.id}/intents/${beta.intent.id}/outcomes/${beta.outcome.id}`, { title: "x" });
  const betaMembers = (await json(await send(ctx, beta.members.owner, "GET", `/api/projects/${beta.project.id}/members`))).members as {
    membership: { id: string };
  }[];
  await notFound(outsider, "PATCH", `/api/projects/${alpha.project.id}/members/${betaMembers[0]!.membership.id}`, { role: "viewer" });
  assert.equal((await json(await send(ctx, beta.members.viewer, "GET", `/api/projects/${beta.project.id}/intents/${beta.intent.id}`))).intent.title, "I");

  // 取消済みMembershipは次のrequestから404（Sessionは失効させない）。
  const viewerMembership = (
    await json(await send(ctx, beta.members.owner, "GET", `/api/projects/${beta.project.id}/members`))
  ).members.find((member: { human: { id: string } }) => member.human.id === beta.members.viewer.humanUserId).membership.id;
  assert.equal((await send(ctx, beta.members.owner, "DELETE", `/api/projects/${beta.project.id}/members/${viewerMembership}`)).status, 200);
  await notFound(beta.members.viewer, "GET", `/api/projects/${beta.project.id}`);
  assert.deepEqual((await json(await send(ctx, beta.members.viewer, "GET", "/api/projects"))).projects, []);
  assert.equal((await send(ctx, beta.members.viewer, "GET", "/api/auth/session")).status, 404, "auth routes are not registered without humanAuth");
  await ctx.database.destroy();
});

test("Session無し・未知・Bearerだけの呼出しは401、CSRF・Origin不一致の変更は403で、何も保存しない", async () => {
  const ctx = await setup();
  const { project, members } = await seedProject(ctx);
  const paths = ["/api/projects", `/api/projects/${project.id}`, `/api/projects/${project.id}/intents`, `/api/projects/${project.id}/members`];
  for (const path of paths) {
    assert.equal((await ctx.app.request(path)).status, 401, path);
    assert.equal((await ctx.app.request(path, { headers: { Cookie: `${testSessionCookie}=unknown` } })).status, 401, path);
    // Agent・RuntimeのBearerでHuman向けAPIは呼べない。
    const bearer = await ctx.app.request(path, { headers: { Authorization: "Bearer agent-1" } });
    assert.equal(bearer.status, 401, path);
    assert.equal((await json(bearer)).error.code, "UNAUTHENTICATED");
  }
  const post = (headers: Headers) =>
    ctx.app.request(`/api/projects/${project.id}/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "x", desiredState: "S" }),
    });
  const noCsrf = humanHeaders(members.owner, { "Content-Type": "application/json" });
  noCsrf.delete("X-Compass-CSRF");
  assert.equal((await post(noCsrf)).status, 403);
  const otherOrigin = humanHeaders(members.owner, { "Content-Type": "application/json" });
  otherOrigin.set("Origin", "http://evil.example");
  assert.equal((await post(otherOrigin)).status, 403);
  const anonymousCreate = await ctx.app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Anonymous", mission: "m" }),
  });
  assert.equal(anonymousCreate.status, 401);
  assert.equal((await json(await send(ctx, members.owner, "GET", `/api/projects/${project.id}/intents`))).intents.length, 1);
  assert.equal((await ctx.database.selectFrom("project").select("id").execute()).length, 1);
  await ctx.database.destroy();
});

test("Membership管理: owner以外のRole変更・自己昇格・取消を拒否し、最後のownerの降格・取消は409 LAST_OWNER", async () => {
  const ctx = await setup();
  const { project, members } = await seedProject(ctx);
  const base = `/api/projects/${project.id}`;
  const list = async () =>
    (await json(await send(ctx, members.owner, "GET", `${base}/members`))).members as { membership: { id: string; role: string }; human: { id: string } }[];
  const membershipOf = async (human: TestHuman) => (await list()).find((member) => member.human.id === human.humanUserId)!.membership.id;

  // administratorは自分・他人のRoleを変えられず、ownerへの自己昇格もできない。
  const adminId = await membershipOf(members.administrator);
  for (const role of ["administrator", "editor", "viewer"] as const) {
    assert.equal((await send(ctx, members[role], "PATCH", `${base}/members/${adminId}`, { role: "owner" })).status, 403, role);
    assert.equal((await send(ctx, members[role], "DELETE", `${base}/members/${await membershipOf(members.viewer)}`)).status, 403, role);
  }
  assert.equal((await list()).find((member) => member.membership.id === adminId)!.membership.role, "administrator");

  // 唯一のownerは自分を降格・取消できない。
  const ownerId = await membershipOf(members.owner);
  const demote = await send(ctx, members.owner, "PATCH", `${base}/members/${ownerId}`, { role: "viewer" });
  assert.equal(demote.status, 409);
  assert.equal((await json(demote)).error.conflict, "LAST_OWNER");
  const revoke = await send(ctx, members.owner, "DELETE", `${base}/members/${ownerId}`);
  assert.equal(revoke.status, 409);
  assert.equal((await json(revoke)).error.conflict, "LAST_OWNER");

  // 他にownerがいれば降格できる。以後、元ownerはMembership管理を行えない。
  const promoted = await send(ctx, members.owner, "PATCH", `${base}/members/${adminId}`, { role: "owner" });
  assert.equal(promoted.status, 200);
  assert.equal((await json(promoted)).membership.role, "owner");
  assert.equal((await send(ctx, members.owner, "PATCH", `${base}/members/${ownerId}`, { role: "editor" })).status, 200);
  assert.equal((await send(ctx, members.owner, "PATCH", `${base}/members/${ownerId}`, { role: "owner" })).status, 403);
  assert.equal((await send(ctx, members.owner, "GET", `${base}/invitations`)).status, 403);
  assert.equal((await send(ctx, members.administrator, "PATCH", `${base}/members/${ownerId}`, { role: "not-a-role" })).status, 400);
  await ctx.database.destroy();
});

test("招待はownerだけが発行・一覧・取消でき、tokenは発行応答のリンクで一度だけ返す", async () => {
  const ctx = await setup();
  const { project, members } = await seedProject(ctx);
  const base = `/api/projects/${project.id}`;
  const created = await send(ctx, members.owner, "POST", `${base}/invitations`, { email: "Guest@Example.com", role: "editor" });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("Cache-Control"), "no-store");
  const body = await json(created);
  assert.match(body.invitationUrl, /^http:\/\/localhost\/invite#[A-Za-z0-9_-]{43}$/);
  assert.equal(body.invitation.email, "guest@example.com");
  assert.equal("tokenHash" in body.invitation, false);
  const token = body.invitationUrl.split("#")[1];

  const listed = await send(ctx, members.owner, "GET", `${base}/invitations`);
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  assert.equal(listedText.includes(token), false);
  const duplicate = await send(ctx, members.owner, "POST", `${base}/invitations`, { email: "guest@example.com", role: "viewer" });
  assert.equal(duplicate.status, 409);
  assert.equal((await json(duplicate)).error.conflict, "INVITATION_PENDING");

  assert.equal((await send(ctx, members.administrator, "DELETE", `${base}/invitations/${body.invitation.id}`)).status, 403);
  const revoked = await send(ctx, members.owner, "DELETE", `${base}/invitations/${body.invitation.id}`);
  assert.equal(revoked.status, 200);
  assert.equal((await json(revoked)).invitation.status, "revoked");
  assert.equal((await send(ctx, members.owner, "DELETE", `${base}/invitations/${body.invitation.id}`)).status, 409);
  await ctx.database.destroy();
});

test("Runtime向けAPIはSession Cookieでは認可せずBearer + runtime Grantだけを受け付け、MCPはMembershipを適用しない", async () => {
  const ctx = await setup();
  const { project, members } = await seedProject(ctx);
  // ownerのSessionがあっても、Bearer無しのRuntime APIはUNAUTHENTICATED。
  const bySession = await requestAs(ctx.app, members.owner)(`/api/projects/${project.id}/runtime-events`);
  assert.equal(bySession.status, 401);
  // Human MembershipはAgent Grantではない（Human IDをBearerにしてもGrantが無ければFORBIDDEN）。
  const byHumanId = await ctx.app.request(`/api/projects/${project.id}/runtime-events`, {
    headers: { Authorization: `Bearer ${members.owner.humanUserId}` },
  });
  assert.equal(byHumanId.status, 403);
  // administratorがWeb APIで発行したruntime GrantのBearerで取得できる（Agent Grantの既存境界）。
  assert.equal((await send(ctx, members.administrator, "POST", `/api/projects/${project.id}/grants`, { principalId: "runtime-1", role: "runtime" })).status, 201);
  const byRuntime = await ctx.app.request(`/api/projects/${project.id}/runtime-events`, { headers: { Authorization: "Bearer runtime-1" } });
  assert.equal(byRuntime.status, 200);
  await ctx.database.destroy();
});

test("application層: Human向けuse caseはMembership認可を委譲先より先に行い、拒否時は委譲先を呼ばない", async () => {
  const ctx = await setup();
  const { project, members } = await seedProject(ctx);
  const actor = (human: TestHuman) => ({ kind: "human", humanUserId: human.humanUserId }) as const;
  await assert.rejects(
    ctx.services.human.createIntent.execute(actor(members.viewer), project.id, { title: "x", desiredState: "S" }),
    (error) => error instanceof ForbiddenError && error.details.requiredRole === humanProjectPermissions["direction.write"],
  );
  // 入力が不正でも、未所属なら入力検証より先にNOT_FOUND。
  const outsider = await createTestHuman(ctx.database);
  await assert.rejects(ctx.services.human.updateProject.execute(actor(outsider), project.id, { name: "" }), NotFoundError);
  await assert.rejects(ctx.services.human.getProject.execute(actor(outsider), "missing"), NotFoundError);
  assert.equal((await ctx.services.listIntentsUseCase.execute(project.id)).length, 1);
  assert.equal((await ctx.services.human.getProject.execute(actor(members.editor), project.id)).myRole, "editor");
  await ctx.database.destroy();
});

test("Agent / Runtime Credential管理にも権限表を適用する: administrator以上だけ、未所属・取消済み・別Projectの子IDは404、CSRF必須", async () => {
  const ctx = await setup();
  const alpha = await seedProject(ctx, "Alpha");
  const beta = await seedProject(ctx, "Beta");
  const base = `/api/projects/${alpha.project.id}/credentials`;
  const issue = (human: TestHuman, projectId: string, principalId: string) =>
    send(ctx, human, "POST", `/api/projects/${projectId}/credentials`, { kind: "agent", principalId });
  const issued = async (human: TestHuman, projectId: string, principalId: string) => {
    const response = await issue(human, projectId, principalId);
    assert.equal(response.status, 201, principalId);
    return (await json(response)).credential as { id: string };
  };
  const alphaCredential = await issued(alpha.members.owner, alpha.project.id, "worker-alpha");
  const betaCredential = await issued(beta.members.owner, beta.project.id, "worker-beta");

  // 一覧・発行・rotation・取消は、editor・viewerには403（requiredRole付き）、administrator・ownerには許可。
  const commands = [
    ["list", "GET", base, undefined],
    ["issue", "POST", base, { kind: "agent", principalId: "denied" }],
    ["rotate", "POST", `${base}/${alphaCredential.id}/rotate`, {}],
    ["revoke", "DELETE", `${base}/${alphaCredential.id}`, undefined],
  ] as const;
  for (const role of ["editor", "viewer"] as const) {
    for (const [label, method, path, body] of commands) {
      const denied = await send(ctx, alpha.members[role], method, path, body);
      assert.equal(denied.status, 403, `${role} ${label}`);
      assert.equal((await json(denied)).error.requiredRole, humanProjectPermissions["credential.manage"]);
    }
  }
  assert.equal(humanProjectPermissions["credential.manage"], "administrator");
  assert.equal((await send(ctx, alpha.members.administrator, "GET", base)).status, 200);
  await issued(alpha.members.administrator, alpha.project.id, "worker-by-administrator");

  // 未所属のProjectは存在を漏らさず404。自分のProjectのURLに別ProjectのCredential IDを混ぜても変更できない。
  const outsider = alpha.members.owner;
  for (const [method, path, body] of [
    ["GET", `/api/projects/${beta.project.id}/credentials`, undefined],
    ["POST", `/api/projects/${beta.project.id}/credentials`, { kind: "agent", principalId: "x" }],
    ["DELETE", `/api/projects/${beta.project.id}/credentials/${betaCredential.id}`, undefined],
    ["POST", `${base}/${betaCredential.id}/rotate`, {}],
    ["DELETE", `${base}/${betaCredential.id}`, undefined],
  ] as const) {
    assert.equal((await send(ctx, outsider, method, path, body)).status, 404, `${method} ${path}`);
  }

  // 取消済みMembershipは次のrequestから404。
  const administratorMembership = (
    await json(await send(ctx, alpha.members.owner, "GET", `/api/projects/${alpha.project.id}/members`))
  ).members.find((member: { human: { id: string } }) => member.human.id === alpha.members.administrator.humanUserId).membership.id;
  assert.equal(
    (await send(ctx, alpha.members.owner, "DELETE", `/api/projects/${alpha.project.id}/members/${administratorMembership}`)).status,
    200,
  );
  assert.equal((await send(ctx, alpha.members.administrator, "GET", base)).status, 404);
  assert.equal((await issue(alpha.members.administrator, alpha.project.id, "after-revoke")).status, 404);

  // CSRF tokenの無い発行は403で保存しない。
  const noCsrf = humanHeaders(alpha.members.owner, { "Content-Type": "application/json" });
  noCsrf.delete("X-Compass-CSRF");
  const forged = await ctx.app.request(base, { method: "POST", headers: noCsrf, body: JSON.stringify({ kind: "agent", principalId: "forged" }) });
  assert.equal(forged.status, 403);

  // 拒否された操作は何も変えていない。
  const listed = (await json(await send(ctx, alpha.members.owner, "GET", base))).credentials as { principalId: string; revokedAt: number | null }[];
  assert.deepEqual(listed.map((credential) => credential.principalId).sort(), ["worker-alpha", "worker-by-administrator"]);
  assert.ok(listed.every((credential) => credential.revokedAt === null));
  const betaListed = (await json(await send(ctx, beta.members.owner, "GET", `/api/projects/${beta.project.id}/credentials`))).credentials;
  assert.equal(betaListed.length, 1);
  assert.equal(betaListed[0].revokedAt, null);

  // application層でも、入力検証・永続化より先に認可する。
  const actor = (human: TestHuman) => ({ kind: "human", humanUserId: human.humanUserId }) as const;
  await assert.rejects(
    ctx.services.issueAccessCredentialUseCase.execute(actor(alpha.members.viewer), alpha.project.id, { kind: "invalid" }),
    (error) => error instanceof ForbiddenError && error.details.requiredRole === "administrator",
  );
  await assert.rejects(ctx.services.listAccessCredentialsUseCase.execute(actor(outsider), beta.project.id), NotFoundError);
  await ctx.database.destroy();
});
