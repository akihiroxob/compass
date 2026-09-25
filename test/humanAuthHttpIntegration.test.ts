import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Kysely } from "kysely";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { sessionIdleTtlMs } from "../src/domain/model/HumanAuth.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import type { Database } from "../src/infrastructure/database/schema.ts";
import { GoogleOidcIdentityProvider } from "../src/infrastructure/identity/GoogleOidcIdentityProvider.ts";
import { assertBootstrapConfigured, loadHumanAuthConfig } from "../src/presentation/http/humanAuthConfig.ts";
import { createOidcFixture, type Claims } from "./support/oidcFixture.ts";

/**
 * Task 44: Human認証・認可を実HTTP server（@hono/node-server、実port）で通して検証する。
 * Googleだけはテスト用OIDC provider（token endpoint・JWKS）を本番のGoogleOidcIdentityProviderへ注入して代替する。
 * 実Googleとの接続はここでは検証しない（docs/step-6-human-auth-design.md「実装記録（Task 44）」）。
 * Humanの操作はすべてWeb経路（/auth/*・/api/*）で行い、CLIや直接DB操作を使わない（DBはassertの観測にだけ読む）。
 */

const publicOrigin = "https://compass.example.com";
const clientId = "client-44.apps.googleusercontent.com";
const clientSecret = "client-secret-44-DO-NOT-LEAK";
const ownerEmail = "owner@example.com";
const oidcSettings = {
  clientId,
  clientSecret,
  redirectUri: `${publicOrigin}/auth/google/callback`,
  endpoints: { authorization: "https://idp.test/authorize", token: "https://idp.test/token", jwks: "https://idp.test/jwks" },
};
const sessionCookie = "__Host-compass_session";
const loginCookie = "__Host-compass_login";

// sandbox等でloopbackへのlistenが禁止された環境では実行できない。拒否だけを理由付きでskipする。
const loopbackDenial = await new Promise<string | undefined>((resolve) => {
  const probe = createServer();
  probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EPERM" || error.code === "EACCES" ? error.code : undefined));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(undefined)));
});
const loopbackSkip = loopbackDenial ? `127.0.0.1へのlistenが拒否された（${loopbackDenial}）。sandbox外で実行すること` : false;

type Running = { baseUrl: string; close: () => Promise<void> };

const listen = (app: ReturnType<typeof createApp>) =>
  new Promise<Running>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            (server as Server).closeAllConnections();
            (server as Server).close((error) => (error ? fail(error) : done()));
          }),
      });
    });
    (server as Server).once("error", reject);
  });

/**
 * `src/server.ts`と同じ手順（設定検査 → schema → services → bootstrap検査 → createApp）で、DB fileを開いて実portで起動する。
 * 違いはGoogleOidcIdentityProviderのendpoint・fetchをOIDC fixtureへ差し替える点と、時刻を進められる点だけ。
 */
const startServer = async (path: string, clock: { now: number }, fixture: ReturnType<typeof createOidcFixture>) => {
  const config = loadHumanAuthConfig(
    {
      COMPASS_PUBLIC_ORIGIN: publicOrigin,
      COMPASS_GOOGLE_CLIENT_ID: clientId,
      COMPASS_GOOGLE_CLIENT_SECRET: clientSecret,
      COMPASS_INITIAL_OWNER_EMAIL: ownerEmail,
    },
    { port: 51800 },
  );
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => clock.now, {
    initialOwnerEmail: config.initialOwnerEmail,
    identityProvider: new GoogleOidcIdentityProvider(config.google!, {
      fetch: fixture.fetch,
      clock: () => clock.now,
      endpoints: oidcSettings.endpoints,
    }),
  });
  assertBootstrapConfigured(config, await services.getHumanAuthBootstrapStatusUseCase.execute());
  const running = await listen(createApp(services, { humanAuth: { mode: config.mode, publicOrigin: config.publicOrigin } }));
  return {
    ...running,
    database,
    stop: async () => {
      await running.close();
      await database.destroy();
    },
  };
};

type HttpResponse = { status: number; headers: Headers; text: string; json: <T = any>() => T };

/**
 * Cookie jarを持つブラウザ相当のclient。redirectは追わず、Set-Cookieを保存して次のrequestへ送る。
 * 受け取った本文・Location・Set-Cookieはすべて`transcript`へ残し、秘密の非露出検査に使う。
 */
const createBrowser = (baseUrl: () => string, transcript: string[]) => {
  const jar = new Map<string, string>();
  const browser = {
    jar,
    setCookieLines: [] as string[],
    async request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<HttpResponse> {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await fetch(`${baseUrl()}${path}`, {
        ...init,
        redirect: "manual",
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
      });
      for (const line of response.headers.getSetCookie()) {
        browser.setCookieLines.push(line);
        const [pair] = line.split(";");
        const index = pair!.indexOf("=");
        const name = pair!.slice(0, index);
        const value = decodeURIComponent(pair!.slice(index + 1));
        if (/Max-Age=0/i.test(line) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
      const text = await response.text();
      transcript.push(text, response.headers.get("Location") ?? "", ...response.headers.getSetCookie());
      return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
    },
    /** 同一originのSPAからのform POST（ログイン開始）。 */
    postForm(path: string, form: Record<string, string>, headers: Record<string, string> = { Origin: publicOrigin }) {
      return browser.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(form).toString(),
      });
    },
    csrfToken: undefined as string | undefined,
    async restoreSession() {
      const response = await browser.request("/api/auth/session");
      browser.csrfToken = response.status === 200 ? response.json<{ csrfToken: string }>().csrfToken : undefined;
      return response;
    },
    /** Web UI（api.ts）と同じく、非安全methodへCSRF tokenとOriginを付ける。 */
    api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      return browser.request(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "GET" ? {} : { Origin: publicOrigin, "X-Compass-CSRF": browser.csrfToken ?? "" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    session: () => jar.get(sessionCookie),
  };
  return browser;
};
type Browser = ReturnType<typeof createBrowser>;

/** ログイン開始（form POST）→ IdPでの同意（fixtureがcodeを発行）→ callbackまでを、ブラウザと同じ順で行う。 */
const loginWithGoogle = async (
  browser: Browser,
  fixture: ReturnType<typeof createOidcFixture>,
  identity: { subject: string; email: string; claims?: Claims },
  options: { form?: Record<string, string>; state?: string } = {},
) => {
  const started = await browser.postForm("/auth/google/login", options.form ?? {});
  assert.equal(started.status, 302);
  const authorization = new URL(started.headers.get("Location")!);
  assert.equal(`${authorization.origin}${authorization.pathname}`, oidcSettings.endpoints.authorization);
  const code = `code-${crypto.randomUUID()}`;
  fixture.codes.set(code, {
    claims: fixture.claims(identity.subject, identity.email, authorization.searchParams.get("nonce")!, identity.claims),
    challenge: authorization.searchParams.get("code_challenge")!,
  });
  const state = options.state ?? authorization.searchParams.get("state")!;
  const callback = await browser.request(`/auth/google/callback?${new URLSearchParams({ code, state })}`);
  assert.equal(callback.status, 302);
  await browser.restoreSession();
  return {
    location: callback.headers.get("Location"),
    secrets: [code, authorization.searchParams.get("state")!, authorization.searchParams.get("nonce")!],
  };
};

const count = async (database: Kysely<Database>, table: "human_user" | "human_identity" | "web_session" | "project_membership" | "project") =>
  Number((await database.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow()).n);

const humanRows = async (database: Kysely<Database>) => ({
  human_user: await count(database, "human_user"),
  human_identity: await count(database, "human_identity"),
  web_session: await count(database, "web_session"),
  project_membership: await count(database, "project_membership"),
});

const invitationToken = (response: HttpResponse) => new URL(response.json<{ invitationUrl: string }>().invitationUrl).hash.slice(1);

const mcp = async (baseUrl: string, method: string, params: object, authorization?: string) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return { status: response.status, body: (data ? JSON.parse(data.slice(6)) : JSON.parse(text)) as Record<string, any> };
};

test(
  "空DBの実HTTP serverで、owner初回ログイン→Project作成→招待→招待Userログイン→Role別操作→logoutまでをWeb経路だけで通す",
  { skip: loopbackSkip },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "compass-auth-http-"));
    const path = join(directory, "compass.db");
    const clock = { now: 1_800_000_000_000 };
    const fixture = createOidcFixture(clock, oidcSettings);
    const transcript: string[] = [];
    const secrets: string[] = [clientSecret, "ya29.access-token-DO-NOT-LEAK"];
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let server = await startServer(path, clock, fixture);
    const browser = () => createBrowser(() => server.baseUrl, transcript);
    try {
      // --- 未認証: Human向けAPIはSessionを要求し、HTMLは秘密を含まない
      const anonymous = browser();
      assert.equal((await anonymous.request("/api/auth/session")).status, 401);
      assert.equal((await anonymous.request("/api/projects")).status, 401);
      assert.equal((await anonymous.request("/api/auth/methods")).json().google, true);
      assert.equal((await anonymous.request("/api/auth/methods")).json().local, false);
      assert.equal((await anonymous.postForm("/auth/local/login", { email: ownerEmail })).status, 404);

      // --- 未許可accountはDB行を増やさない
      const stranger = browser();
      const denied = await loginWithGoogle(stranger, fixture, { subject: "stranger-sub", email: "stranger@example.com" });
      assert.equal(denied.location, "/login?error=not_allowed");
      assert.equal(stranger.session(), undefined);
      assert.deepEqual(await humanRows(server.database), { human_user: 0, human_identity: 0, web_session: 0, project_membership: 0 });
      // 改ざんstate・nonce不一致もoidc_failedで、行を作らない。
      assert.equal((await loginWithGoogle(stranger, fixture, { subject: "owner-sub", email: ownerEmail }, { state: "forged" })).location, "/login?error=oidc_failed");
      assert.equal(
        (await loginWithGoogle(stranger, fixture, { subject: "owner-sub", email: ownerEmail, claims: { nonce: "forged" } })).location,
        "/login?error=oidc_failed",
      );
      assert.deepEqual(await humanRows(server.database), { human_user: 0, human_identity: 0, web_session: 0, project_membership: 0 });

      // --- 初期ownerの初回ログイン（Session fixation: login前に仕込まれたCookieを使わない）。open redirectは`/`へ落とす
      const owner = browser();
      owner.jar.set(sessionCookie, "attacker-planted-session");
      const ownerLogin = await loginWithGoogle(owner, fixture, { subject: "owner-sub", email: ownerEmail }, { form: { returnTo: "//evil.example.com/steal" } });
      secrets.push(...ownerLogin.secrets);
      assert.equal(ownerLogin.location, "/");
      assert.notEqual(owner.session(), "attacker-planted-session");
      secrets.push(owner.session()!, owner.csrfToken!);
      const sessionLine = [...owner.setCookieLines].reverse().find((line) => line.startsWith(`${sessionCookie}=`))!;
      for (const attribute of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\//]) assert.match(sessionLine, attribute);
      assert.doesNotMatch(sessionLine, /Domain=/);
      assert.match([...owner.setCookieLines].reverse().find((line) => line.startsWith(`${loginCookie}=`))!, /Max-Age=0/);
      assert.equal(owner.jar.has(loginCookie), false);
      for (const returnTo of ["https://evil.example.com", "/\\evil.example.com"]) {
        const relogin = browser();
        assert.equal((await loginWithGoogle(relogin, fixture, { subject: "owner-sub", email: ownerEmail }, { form: { returnTo } })).location, "/");
        secrets.push(relogin.session()!);
      }

      // --- CSRF: token無し・別Origin・Bearerだけの変更は拒否し、何も保存しない
      const projectInput = { name: "Compass", mission: "Keep direction explicit" };
      assert.equal((await owner.api("POST", "/api/projects", projectInput, { "X-Compass-CSRF": "" })).status, 403);
      assert.equal((await owner.api("POST", "/api/projects", projectInput, { Origin: "https://evil.example.com" })).status, 403);
      const bearerOnly = await anonymous.api("POST", "/api/projects", projectInput, { Authorization: "Bearer owner" });
      assert.equal(bearerOnly.status, 401);
      assert.equal(await count(server.database, "project"), 0);
      // Human向け`/api/*`は他originへCORSを許さない。
      const preflight = await anonymous.request("/api/projects", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
      });
      assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null);

      // --- Project作成（作成者はowner）と招待
      const created = await owner.api("POST", "/api/projects", projectInput);
      assert.equal(created.status, 201);
      const projectId = created.json().project.id as string;
      const other = await owner.api("POST", "/api/projects", { name: "Other", mission: "Separate" });
      const otherProjectId = other.json().project.id as string;
      assert.equal((await owner.api("GET", `/api/projects/${projectId}`)).json().myRole, "owner");

      const editorInvite = await owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "Editor@Example.com", role: "editor" });
      assert.equal(editorInvite.status, 201);
      assert.equal(editorInvite.headers.get("Cache-Control"), "no-store");
      const viewerInvite = await owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "viewer@example.com", role: "viewer" });
      const editorToken = invitationToken(editorInvite);
      const viewerToken = invitationToken(viewerInvite);
      secrets.push(editorToken, viewerToken);
      const listed = await owner.api("GET", `/api/projects/${projectId}/invitations`);
      assert.equal(listed.text.includes(editorToken), false);

      // 招待tokenだけでは受諾できない（OIDCで検証したemailと照合する）。
      const thief = browser();
      assert.equal(
        (await loginWithGoogle(thief, fixture, { subject: "thief-sub", email: "thief@example.com" }, { form: { invitationToken: editorToken } })).location,
        "/login?error=not_allowed",
      );

      // --- 招待Userのログイン
      const editor = browser();
      const editorLogin = await loginWithGoogle(editor, fixture, { subject: "editor-sub", email: "editor@example.com" }, { form: { invitationToken: editorToken, returnTo: `/projects/${projectId}` } });
      assert.equal(editorLogin.location, `/projects/${projectId}`);
      secrets.push(editor.session()!, ...editorLogin.secrets);
      const viewer = browser();
      await loginWithGoogle(viewer, fixture, { subject: "viewer-sub", email: "viewer@example.com" }, { form: { invitationToken: viewerToken } });
      secrets.push(viewer.session()!);
      // 使用済みの招待は再利用できない。
      const replay = browser();
      assert.equal(
        (await loginWithGoogle(replay, fixture, { subject: "replay-sub", email: "editor@example.com" }, { form: { invitationToken: editorToken } })).location,
        "/login?error=not_allowed",
      );

      // --- Role別操作（application層の権限表。UI非表示ではなくserverが拒否する）
      assert.deepEqual((await editor.api("GET", "/api/projects")).json().projects.map((project: { id: string }) => project.id), [projectId]);
      assert.equal((await editor.api("GET", `/api/projects/${projectId}`)).json().myRole, "editor");
      const intent = await editor.api("POST", `/api/projects/${projectId}/intents`, { title: "Ship auth", desiredState: "Humans sign in" });
      assert.equal(intent.status, 201);
      assert.equal((await editor.api("PATCH", `/api/projects/${projectId}`, { mission: "Hijacked" })).status, 403);
      assert.equal((await editor.api("POST", `/api/projects/${projectId}/invitations`, { email: "x@example.com", role: "owner" })).status, 403);
      assert.equal((await editor.api("GET", `/api/projects/${otherProjectId}`)).status, 404);
      assert.equal((await editor.api("GET", `/api/projects/${crypto.randomUUID()}`)).status, 404);
      const members = (await viewer.api("GET", `/api/projects/${projectId}/members`)).json().members as { membership: { id: string; role: string }; human: { email: string } }[];
      assert.deepEqual(members.map((member) => [member.human.email, member.membership.role]).sort(), [
        ["editor@example.com", "editor"],
        [ownerEmail, "owner"],
        ["viewer@example.com", "viewer"],
      ]);
      const viewerIntent = await viewer.api("POST", `/api/projects/${projectId}/intents`, { title: "No", desiredState: "No" });
      assert.equal(viewerIntent.status, 403);
      assert.equal(viewerIntent.json().error.requiredRole, "editor");
      const ownerMembership = members.find((member) => member.human.email === ownerEmail)!.membership.id;
      assert.equal((await owner.api("DELETE", `/api/projects/${projectId}/members/${ownerMembership}`)).json().error.conflict, "LAST_OWNER");

      // --- 招待の取消・期限切れ・再発行・並行発行
      const revokedInvite = await owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "revoked@example.com", role: "viewer" });
      secrets.push(invitationToken(revokedInvite));
      await owner.api("DELETE", `/api/projects/${projectId}/invitations/${revokedInvite.json().invitation.id}`);
      assert.equal(
        (await loginWithGoogle(browser(), fixture, { subject: "revoked-sub", email: "revoked@example.com" }, { form: { invitationToken: invitationToken(revokedInvite) } })).location,
        "/login?error=not_allowed",
      );
      const lateInvite = await owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "late@example.com", role: "viewer", expiresInHours: 1 });
      secrets.push(invitationToken(lateInvite));
      const usersBeforeExpired = await count(server.database, "human_user");
      clock.now += 60 * 60 * 1000 + 1;
      assert.equal(
        (await loginWithGoogle(browser(), fixture, { subject: "late-sub", email: "late@example.com" }, { form: { invitationToken: invitationToken(lateInvite) } })).location,
        "/login?error=invitation_expired",
      );
      assert.equal(await count(server.database, "human_user"), usersBeforeExpired);
      const reissued = await owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "late@example.com", role: "viewer" });
      assert.equal(reissued.status, 201);
      secrets.push(invitationToken(reissued));
      assert.equal(
        (await loginWithGoogle(browser(), fixture, { subject: "late-sub", email: "late@example.com" }, { form: { invitationToken: invitationToken(lateInvite) } })).location,
        "/login?error=not_allowed",
      );
      const concurrent = await Promise.all([
        owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "dup@example.com", role: "viewer" }),
        owner.api("POST", `/api/projects/${projectId}/invitations`, { email: "dup@example.com", role: "viewer" }),
      ]);
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
      assert.equal(concurrent.find((response) => response.status === 409)!.json().error.conflict, "INVITATION_PENDING");
      secrets.push(invitationToken(concurrent.find((response) => response.status === 201)!));

      // --- Membership取消は次のrequestから反映される
      const viewerMembership = members.find((member) => member.human.email === "viewer@example.com")!.membership.id;
      assert.equal((await owner.api("DELETE", `/api/projects/${projectId}/members/${viewerMembership}`)).status, 200);
      assert.equal((await viewer.api("GET", `/api/projects/${projectId}`)).status, 404);

      // --- Session fixation: 他人の有効Sessionを仕込まれたブラウザでログインすると、仕込まれたSessionは失効する
      const planted = browser();
      planted.jar.set(sessionCookie, viewer.session()!);
      await loginWithGoogle(planted, fixture, { subject: "editor-sub", email: "editor@example.com" });
      assert.notEqual(planted.session(), viewer.session());
      secrets.push(planted.session()!);
      assert.equal((await viewer.restoreSession()).status, 401);

      // --- logout（CSRF必須）
      assert.equal((await planted.request("/api/auth/logout", { method: "POST" })).status, 403);
      assert.equal((await planted.api("POST", "/api/auth/logout")).status, 204);
      assert.equal(planted.session(), undefined);

      // --- Sessionのアイドル期限切れ（editorはowner操作中にrequestしていない）
      clock.now += sessionIdleTtlMs + 1;
      assert.equal((await editor.restoreSession()).status, 401);
      const ownerAgain = browser();
      await loginWithGoogle(ownerAgain, fixture, { subject: "owner-sub", email: ownerEmail });
      secrets.push(ownerAgain.session()!);

      // --- server再起動: Session・Membership・招待・失効状態がDBから復元される
      await server.stop();
      server = await startServer(path, clock, fixture);
      assert.equal((await ownerAgain.restoreSession()).status, 200);
      assert.equal((await owner.restoreSession()).status, 401);
      assert.equal((await viewer.api("GET", `/api/projects/${projectId}`)).status, 401);
      const invitations = (await ownerAgain.api("GET", `/api/projects/${projectId}/invitations`)).json().invitations as { email: string; status: string }[];
      assert.deepEqual(
        invitations.filter((invitation) => invitation.email === "late@example.com").map((invitation) => invitation.status).sort(),
        ["pending", "revoked"],
      );
      const editorAgain = browser();
      await loginWithGoogle(editorAgain, fixture, { subject: "editor-sub", email: "editor@example.com" });
      secrets.push(editorAgain.session()!);
      assert.equal((await editorAgain.api("GET", `/api/projects/${projectId}/intents`)).json().intents.length, 1);
      assert.equal(await count(server.database, "human_user"), 3, "owner・editor・viewer以外のHumanを作らない");

      // --- /mcp: 匿名はRole文書だけ、Human向けCommandは未知tool、Agent名だけのBearerは401
      const tools = await mcp(server.baseUrl, "tools/list", {});
      assert.deepEqual(tools.body.result.tools.map((tool: { name: string }) => tool.name), ["get_role_instructions"]);
      for (const [name, args] of [
        ["create_project", { name: "Orphan", mission: "via MCP" }],
        ["update_project", { projectId, mission: "via MCP" }],
        ["create_intent", { projectId, title: "via MCP", desiredState: "x" }],
        ["list_projects", {}],
        ["get_project", { projectId }],
      ] as const) {
        const reply = await mcp(server.baseUrl, "tools/call", { name, arguments: args });
        const message = reply.body.error?.message ?? JSON.stringify(reply.body.result?.content ?? "");
        assert.match(message, new RegExp(`${name}.*not found`, "i"), name);
      }
      assert.equal((await mcp(server.baseUrl, "tools/list", {}, "Bearer strategist-agent")).status, 401);
      // MCPはSession Cookieを読まない。
      const withCookie = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Cookie: `${sessionCookie}=${ownerAgain.session()}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.match(await withCookie.text(), /^(?!.*"create_project").*get_role_instructions/s);
      assert.equal(await count(server.database, "project"), 2);

      // --- HTML（SPA）とログイン拒否画面の応答
      for (const page of ["/", "/login?error=not_allowed", "/invite"]) {
        const html = await anonymous.request(page);
        assert.equal(html.status, 200, page);
      }
    } finally {
      await server.stop().catch(() => undefined);
      console.log = originalLog;
      console.error = originalError;
    }

    // --- 秘密の非露出: DB file・request log・全応答（本文・Location・Set-Cookie以外の値）にGoogle token・Session secret等が無い
    try {
      const databaseText = [path, `${path}-wal`]
        .map((file) => readFile(file).then((buffer) => buffer.toString("latin1"), () => ""));
      const dbText = (await Promise.all(databaseText)).join("");
      const responseText = transcript.filter((entry) => !entry.startsWith(`${sessionCookie}=`)).join("\n");
      const logText = logs.join("\n");
      assert.ok(logText.includes("/auth/google/callback?[redacted]"), "request log is captured and query is redacted");
      for (const secret of [...secrets, ...fixture.issuedIdTokens]) {
        assert.equal(dbText.includes(secret), false, "DB contains a secret");
        assert.equal(logText.includes(secret), false, "log contains a secret");
      }
      // Session secretはSet-Cookieでだけ返す。招待tokenは発行応答（invitationUrl）でだけ返す。
      for (const secret of [clientSecret, "ya29.access-token-DO-NOT-LEAK", ...fixture.issuedIdTokens]) {
        assert.equal(responseText.includes(secret), false, "response contains a Google secret");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "既存DB（認証導入前のProject・Intent・Grant）で起動し、初期ownerの初回ログインで所有者が確定し、管理不能Projectを残さない",
  { skip: loopbackSkip },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "compass-auth-migration-"));
    const path = join(directory, "compass.db");
    try {
      // 認証導入前と同じく、Actor無しのuse case（旧MCP `create_project` 相当）でデータを作る。
      const legacy = createDatabase(path);
      await initializeSchema(legacy);
      const legacyServices = createApplicationServices(legacy);
      const project = await legacyServices.createProjectUseCase.execute({ name: "Legacy", mission: "Existed before auth" });
      await legacyServices.createIntentUseCase.execute(project.id, { title: "Legacy intent", desiredState: "Kept" });
      await legacyServices.grantProjectRoleUseCase.execute(project.id, { principalId: "strategist-1", role: "strategist" });
      const archived = await legacyServices.createProjectUseCase.execute({ name: "Archived", mission: "Read only" });
      await legacyServices.archiveProjectUseCase.execute(archived.id, { reason: "done" });
      await legacy.destroy();

      const clock = { now: 1_800_000_000_000 };
      const fixture = createOidcFixture(clock, oidcSettings);
      const server = await startServer(path, clock, fixture);
      try {
        const owner = createBrowser(() => server.baseUrl, []);
        await loginWithGoogle(owner, fixture, { subject: "owner-sub", email: ownerEmail });
        const active = owner.api("GET", "/api/projects");
        assert.deepEqual((await active).json().projects.map((item: { name: string }) => item.name), ["Legacy"]);
        assert.deepEqual((await owner.api("GET", "/api/projects?status=archived")).json().projects.map((item: { name: string }) => item.name), ["Archived"]);
        assert.equal((await owner.api("GET", `/api/projects/${project.id}`)).json().myRole, "owner");
        assert.equal((await owner.api("GET", `/api/projects/${project.id}/intents`)).json().intents[0].title, "Legacy intent");
        assert.deepEqual((await owner.api("GET", `/api/projects/${project.id}/grants`)).json().grants.map((grant: { principalId: string }) => grant.principalId), ["strategist-1"]);
        const orphans = await server.database
          .selectFrom("project")
          .select("id")
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom("project_membership").select("id").whereRef("project_membership.project_id", "=", "project.id").where("role", "=", "owner").where("revoked_at", "is", null))),
          )
          .execute();
        assert.deepEqual(orphans, []);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// --- `npm start` と同じ `src/server.ts` を子processで起動する（起動コマンド・設定のfail-fast・trusted-localの経路）
const serverEntry = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const runServer = (env: Record<string, string>) => {
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output, exited };
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

test("src/server.tsはremoteの必須値欠落・初期owner未設定で起動を拒否し、secretの値を出力しない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-auth-startup-"));
  try {
    // 設定検査はlisten前に失敗するため、loopback禁止環境でも動くよう固定の妥当なPORTを使う。
    const base = { COMPASS_DB_PATH: join(directory, "compass.db"), PORT: "51800" };
    const missingSecret = runServer({ ...base, COMPASS_PUBLIC_ORIGIN: publicOrigin, COMPASS_GOOGLE_CLIENT_ID: clientId });
    assert.equal(await missingSecret.exited, 1);
    assert.match(missingSecret.output.stderr, /Configuration error: COMPASS_GOOGLE_CLIENT_ID and COMPASS_GOOGLE_CLIENT_SECRET/);
    assert.equal(missingSecret.output.stderr.includes(clientId), false);

    const noOwner = runServer({
      ...base,
      COMPASS_PUBLIC_ORIGIN: publicOrigin,
      COMPASS_GOOGLE_CLIENT_ID: clientId,
      COMPASS_GOOGLE_CLIENT_SECRET: clientSecret,
    });
    assert.equal(await noOwner.exited, 1);
    assert.match(noOwner.output.stderr, /Configuration error: COMPASS_INITIAL_OWNER_EMAIL/);
    assert.equal(`${noOwner.output.stdout}${noOwner.output.stderr}`.includes(clientSecret), false);

    const production = runServer({ ...base, NODE_ENV: "production", COMPASS_AUTH_MODE: "trusted-local", COMPASS_INITIAL_OWNER_EMAIL: ownerEmail });
    assert.equal(await production.exited, 1);
    assert.match(production.output.stderr, /Configuration error: .*production/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "src/server.tsをtrusted-localで起動し、開発用ログイン→Project作成→logoutをHTTPで通し、stdoutへSession secretを出さない",
  { skip: loopbackSkip },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "compass-auth-local-"));
    const port = await freePort();
    const origin = `http://localhost:${port}`;
    const server = runServer({
      COMPASS_DB_PATH: join(directory, "compass.db"),
      PORT: String(port),
      COMPASS_AUTH_MODE: "trusted-local",
      COMPASS_INITIAL_OWNER_EMAIL: ownerEmail,
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!server.output.stdout.includes("Compass running")) {
        assert.ok(Date.now() < deadline, `server did not start: ${server.output.stderr}`);
        assert.equal(server.child.exitCode, null, server.output.stderr);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(server.output.stdout, /127\.0\.0\.1/);
      const transcript: string[] = [];
      const browser = createBrowser(() => `http://127.0.0.1:${port}`, transcript);
      assert.equal(
        (await browser.postForm("/auth/local/login", { email: "stranger@example.com" }, { Origin: origin })).headers.get("Location"),
        "/login?error=not_allowed",
      );
      const login = await browser.postForm("/auth/local/login", { email: ownerEmail, returnTo: "/projects" }, { Origin: origin });
      assert.equal(login.headers.get("Location"), "/projects");
      const cookieLine = browser.setCookieLines.find((line) => line.startsWith("compass_session="))!;
      assert.match(cookieLine, /HttpOnly/);
      assert.match(cookieLine, /SameSite=Lax/);
      const session = browser.jar.get("compass_session")!;
      const { csrfToken } = (await browser.request("/api/auth/session")).json<{ csrfToken: string }>();
      const created = await browser.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, "X-Compass-CSRF": csrfToken },
        body: JSON.stringify({ name: "Local", mission: "Dev" }),
      });
      assert.equal(created.status, 201);
      const logout = await browser.request("/api/auth/logout", { method: "POST", headers: { Origin: origin, "X-Compass-CSRF": csrfToken } });
      assert.equal(logout.status, 204);
      assert.equal((await browser.request("/api/projects", { headers: { Cookie: `compass_session=${session}` } })).status, 401);
      assert.equal(`${server.output.stdout}${server.output.stderr}`.includes(session), false);
      assert.equal(`${server.output.stdout}${server.output.stderr}`.includes(csrfToken), false);
    } finally {
      server.child.kill("SIGTERM");
      await server.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
