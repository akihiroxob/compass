import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Kysely } from "kysely";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { sessionIdleTtlMs } from "../src/domain/model/HumanAuth.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import type { Database } from "../src/infrastructure/database/schema.ts";
import { GoogleOidcIdentityProvider } from "../src/infrastructure/identity/GoogleOidcIdentityProvider.ts";
import {
  assertBootstrapConfigured,
  HumanAuthConfigError,
  loadHumanAuthConfig,
} from "../src/presentation/http/humanAuthConfig.ts";
import type { AuthMode } from "../src/presentation/http/humanAuthConfig.ts";
import { createOidcFixture as createOidcFixtureWith, type Claims } from "./support/oidcFixture.ts";

const publicOrigin = "https://compass.example.com";
const redirectUri = `${publicOrigin}/auth/google/callback`;
const clientId = "client-123.apps.googleusercontent.com";
const clientSecret = "client-secret-DO-NOT-LEAK";
const ownerEmail = "owner@example.com";
const endpoints = {
  authorization: "https://idp.test/authorize",
  token: "https://idp.test/token",
  jwks: "https://idp.test/jwks",
};

const createOidcFixture = (clock: { now: number }) =>
  createOidcFixtureWith(clock, { clientId, clientSecret, redirectUri, endpoints });

const setup = async (options: { path?: string; mode?: AuthMode; providerRedirectUri?: string } = {}) => {
  const database = createDatabase(options.path ?? ":memory:");
  await initializeSchema(database);
  const clock = { now: 1_800_000_000_000 };
  const fixture = createOidcFixture(clock);
  const mode = options.mode ?? "remote";
  const origin = mode === "remote" ? publicOrigin : "http://localhost:51800";
  const services = createApplicationServices(database, undefined, () => clock.now, {
    initialOwnerEmail: ownerEmail,
    identityProvider: new GoogleOidcIdentityProvider(
      { clientId, clientSecret, redirectUri: options.providerRedirectUri ?? redirectUri },
      { fetch: fixture.fetch, clock: () => clock.now, endpoints },
    ),
  });
  const app = createApp(services, { humanAuth: { mode, publicOrigin: origin } });
  return { database, services, app, clock, fixture, origin, mode };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const setCookies = (response: Response) => response.headers.getSetCookie();
const cookieValue = (response: Response, name: string) => {
  const line = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.slice(name.length + 1).split(";")[0]!) : undefined;
};
const sessionCookie = (mode: AuthMode) => (mode === "remote" ? "__Host-compass_session" : "compass_session");
const loginCookie = (mode: AuthMode) => (mode === "remote" ? "__Host-compass_login" : "compass_login");

const startLogin = async (ctx: Setup, form: Record<string, string> = {}, headers: Record<string, string> = { Origin: ctx.origin }) => {
  const response = await ctx.app.request("/auth/google/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return response;
};

/** ログイン開始→（IdPでの同意を模して）codeを発行→callbackまで。 */
const loginFlow = async (
  ctx: Setup,
  identity: { subject: string; email: string; claims?: Claims; tamper?: (token: string) => string },
  options: { form?: Record<string, string>; previousSession?: string; stateOverride?: string; callbackQuery?: Record<string, string> } = {},
) => {
  const started = await startLogin(ctx, options.form);
  assert.equal(started.status, 302);
  const authorization = new URL(started.headers.get("Location")!);
  const attempt = cookieValue(started, loginCookie(ctx.mode))!;
  const nonce = authorization.searchParams.get("nonce")!;
  const code = `code-${Math.random().toString(36).slice(2)}`;
  ctx.fixture.codes.set(code, {
    claims: ctx.fixture.claims(identity.subject, identity.email, nonce, identity.claims),
    challenge: authorization.searchParams.get("code_challenge")!,
    tamper: identity.tamper,
  });
  const query = new URLSearchParams(
    options.callbackQuery ?? { code, state: options.stateOverride ?? authorization.searchParams.get("state")! },
  );
  const cookies = [`${loginCookie(ctx.mode)}=${attempt}`];
  if (options.previousSession) cookies.push(`${sessionCookie(ctx.mode)}=${options.previousSession}`);
  const callback = await ctx.app.request(`/auth/google/callback?${query}`, { headers: { Cookie: cookies.join("; ") } });
  return { started, authorization, attempt, code, callback, session: cookieValue(callback, sessionCookie(ctx.mode)) };
};

const getSession = (ctx: Setup, token: string | undefined) =>
  ctx.app.request("/api/auth/session", { headers: token ? { Cookie: `${sessionCookie(ctx.mode)}=${token}` } : {} });

const countRows = async (database: Kysely<Database>) => {
  const count = async (table: "human_user" | "human_identity" | "web_session" | "project_membership") =>
    Number((await database.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow()).n);
  return {
    human_user: await count("human_user"),
    human_identity: await count("human_identity"),
    web_session: await count("web_session"),
    project_membership: await count("project_membership"),
  };
};
const noRows = { human_user: 0, human_identity: 0, web_session: 0, project_membership: 0 };

test("初期ownerの初回ログインでOIDC応答をserverで検証し、Human・Identityを一度だけ作ってSecure Sessionを発行する", async () => {
  const ctx = await setup();
  const { authorization, callback, session, started } = await loginFlow(
    ctx,
    { subject: "owner-sub", email: ownerEmail },
    { form: { returnTo: "/projects?tab=1" } },
  );

  // 認可要求: code + PKCE(S256)、openid email profileだけ、refresh tokenを要求しない、redirect URIは設定値で固定。
  assert.equal(authorization.origin + authorization.pathname, endpoints.authorization);
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("scope"), "openid email profile");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(authorization.searchParams.get("client_id"), clientId);
  assert.equal(authorization.searchParams.get("access_type"), null);
  assert.equal(authorization.searchParams.has("client_secret"), false);
  const loginAttemptCookie = setCookies(started).find((line) => line.startsWith("__Host-compass_login="))!;
  assert.match(loginAttemptCookie, /HttpOnly/);
  assert.match(loginAttemptCookie, /Secure/);
  assert.match(loginAttemptCookie, /SameSite=Lax/);
  assert.match(loginAttemptCookie, /Max-Age=600/);

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("Location"), "/projects?tab=1");
  const line = setCookies(callback).find((cookie) => cookie.startsWith("__Host-compass_session="))!;
  for (const attribute of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\//, /Max-Age=604800/]) assert.match(line, attribute);
  assert.doesNotMatch(line, /Domain=/);
  // ログイン試行Cookieはcallbackで削除する。
  assert.match(setCookies(callback).find((cookie) => cookie.startsWith("__Host-compass_login="))!, /Max-Age=0/);

  const restored = await getSession(ctx, session);
  assert.equal(restored.status, 200);
  const body = (await restored.json()) as { human: { email: string; displayName: string }; csrfToken: string; expiresAt: number };
  assert.equal(body.human.email, ownerEmail);
  assert.equal(body.human.displayName, "Test User");
  assert.equal(typeof body.csrfToken, "string");
  assert.deepEqual(await countRows(ctx.database), { human_user: 1, human_identity: 1, web_session: 1, project_membership: 0 });
  const identity = await ctx.database.selectFrom("human_identity").selectAll().executeTakeFirstOrThrow();
  assert.deepEqual([identity.provider, identity.issuer, identity.subject], ["google", "https://accounts.google.com", "owner-sub"]);
  await ctx.database.destroy();
});

test("2回目以降はissuer + subで同じHumanへ解決し、email変更で別Humanを作らず、旧Sessionはsupersededになる", async () => {
  const ctx = await setup();
  const first = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
  const second = await loginFlow(
    ctx,
    { subject: "owner-sub", email: "renamed@example.com", claims: { iss: "accounts.google.com" } },
    { previousSession: first.session },
  );
  assert.equal(second.callback.status, 302);
  assert.notEqual(second.session, first.session);
  assert.equal((await getSession(ctx, first.session)).status, 401);
  const restored = (await (await getSession(ctx, second.session)).json()) as { human: { id: string; email: string } };
  assert.equal(restored.human.email, "renamed@example.com");
  assert.deepEqual(await countRows(ctx.database), { human_user: 1, human_identity: 1, web_session: 2, project_membership: 0 });

  // 別subjectで元のemailを名乗っても、platform owner作成後は初期owner emailを読まない。
  const impostor = await loginFlow(ctx, { subject: "other-sub", email: ownerEmail });
  assert.equal(impostor.callback.headers.get("Location"), "/login?error=not_allowed");
  assert.equal((await countRows(ctx.database)).human_user, 1);
  await ctx.database.destroy();
});

test("未許可account・email_verified=falseはnot_allowedで拒否し、human_user・identity・sessionを作らない", async () => {
  const ctx = await setup();
  for (const identity of [
    { subject: "stranger", email: "stranger@example.com" },
    { subject: "owner-sub", email: ownerEmail, claims: { email_verified: false } },
    { subject: "owner-sub", email: ownerEmail, claims: { email_verified: undefined } },
  ]) {
    const { callback, session } = await loginFlow(ctx, identity);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("Location"), "/login?error=not_allowed");
    assert.equal(session, undefined);
  }
  assert.deepEqual(await countRows(ctx.database), noRows);
  await ctx.database.destroy();
});

test("改ざん・issuer / audience / nonce不一致・期限切れ・未来のiat・alg不正のID Tokenはoidc_failedで拒否する", async () => {
  const ctx = await setup();
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const swapPayload = (token: string) => {
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "attacker", email: ownerEmail })).toString("base64url");
    return `${header}.${forged}.${signature}`;
  };
  const cases: { name: string; claims?: Claims; tamper?: (token: string) => string }[] = [
    { name: "payload改ざん", tamper: swapPayload },
    { name: "署名改ざん", tamper: (token) => `${token.slice(0, -4)}AAAA` },
    { name: "別鍵で署名", tamper: (token) => {
      const [header, payload] = token.split(".");
      return `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), otherKey).toString("base64url")}`;
    } },
    { name: "alg none", tamper: (token) => {
      const [, payload] = token.split(".");
      return `${Buffer.from(JSON.stringify({ alg: "none", kid: "key-1" })).toString("base64url")}.${payload}.`;
    } },
    { name: "issuer", claims: { iss: "https://evil.example.com" } },
    { name: "audience", claims: { aud: "other-client" } },
    { name: "nonce", claims: { nonce: "other-nonce" } },
    { name: "期限切れ", claims: { exp: Math.floor(ctx.clock.now / 1000) - 120 } },
    { name: "未来のiat", claims: { iat: Math.floor(ctx.clock.now / 1000) + 600 } },
  ];
  for (const testCase of cases) {
    const { callback } = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail, ...testCase });
    assert.equal(callback.headers.get("Location"), "/login?error=oidc_failed", testCase.name);
  }
  assert.deepEqual(await countRows(ctx.database), noRows);
  await ctx.database.destroy();
});

test("state不一致・ログイン試行の再利用・期限切れ・Cookieなし・IdPのerror・redirect URI不一致はoidc_failedで拒否する", async () => {
  const ctx = await setup();
  assert.equal(
    (await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail }, { stateOverride: "forged-state" })).callback.headers.get("Location"),
    "/login?error=oidc_failed",
  );
  assert.equal(
    (await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail }, { callbackQuery: { error: "access_denied" } })).callback.headers.get("Location"),
    "/login?error=oidc_failed",
  );

  // 同じログイン試行を2回使えない（1回目の成否に関係なく使用済み）。
  const used = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail }, { stateOverride: "forged-state" });
  const replay = await ctx.app.request(
    `/auth/google/callback?code=${used.code}&state=${used.authorization.searchParams.get("state")}`,
    { headers: { Cookie: `__Host-compass_login=${used.attempt}` } },
  );
  assert.equal(replay.headers.get("Location"), "/login?error=oidc_failed");
  const row = await ctx.database.selectFrom("auth_login_attempt").selectAll().where("consumed_at", "is not", null).executeTakeFirstOrThrow();
  assert.deepEqual([row.state, row.nonce, row.code_verifier], [null, null, null]);

  // ログイン試行は10分で期限切れ。
  const started = await startLogin(ctx);
  const authorization = new URL(started.headers.get("Location")!);
  ctx.clock.now += 10 * 60 * 1000 + 1;
  const expired = await ctx.app.request(
    `/auth/google/callback?code=x&state=${authorization.searchParams.get("state")}`,
    { headers: { Cookie: `__Host-compass_login=${cookieValue(started, "__Host-compass_login")}` } },
  );
  assert.equal(expired.headers.get("Location"), "/login?error=oidc_failed");
  const noCookie = await ctx.app.request(`/auth/google/callback?code=x&state=${authorization.searchParams.get("state")}`);
  assert.equal(noCookie.headers.get("Location"), "/login?error=oidc_failed");
  assert.deepEqual(await countRows(ctx.database), noRows);
  await ctx.database.destroy();

  // IdPへ登録されたredirect URIと異なる値でcode交換すると、IdPが拒否する。
  const mismatch = await setup({ providerRedirectUri: "https://evil.example.com/auth/google/callback" });
  const result = await loginFlow(mismatch, { subject: "owner-sub", email: ownerEmail });
  assert.equal(result.callback.headers.get("Location"), "/login?error=oidc_failed");
  assert.deepEqual(await countRows(mismatch.database), noRows);
  await mismatch.database.destroy();
});

test("ログイン開始はOriginを検査し、returnToは同一origin内の相対pathだけを使う（open redirect対策）", async () => {
  const ctx = await setup();
  assert.equal((await startLogin(ctx, {}, {})).status, 403);
  const crossSite = await startLogin(ctx, {}, { Origin: "https://evil.example.com" });
  assert.equal(crossSite.status, 403);
  assert.equal(((await crossSite.json()) as { error: { code: string } }).error.code, "CSRF_REJECTED");
  assert.equal((await startLogin(ctx, {}, { "Sec-Fetch-Site": "same-origin" })).status, 302);

  for (const returnTo of ["//evil.example.com", "https://evil.example.com", "/\\evil.example.com", "/a\r\nb", "relative"]) {
    const { callback } = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail }, { form: { returnTo } });
    assert.equal(callback.headers.get("Location"), "/", returnTo);
  }
  await ctx.database.destroy();
});

test("logoutはCSRF tokenとOriginを要求してSessionを取消し、Session無しでも204を返す", async () => {
  const ctx = await setup();
  const { session } = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
  const { csrfToken } = (await (await getSession(ctx, session)).json()) as { csrfToken: string };
  const logout = (headers: Record<string, string>) =>
    ctx.app.request("/api/auth/logout", { method: "POST", headers: { Cookie: `__Host-compass_session=${session}`, ...headers } });

  const rejectedHeaders: Record<string, string>[] = [
    {},
    { Origin: publicOrigin },
    { Origin: publicOrigin, "X-Compass-CSRF": "wrong" },
    { Origin: "https://evil.example.com", "X-Compass-CSRF": csrfToken },
  ];
  for (const headers of rejectedHeaders) {
    const rejected = await logout(headers);
    assert.equal(rejected.status, 403);
    assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "CSRF_REJECTED");
  }
  assert.equal((await getSession(ctx, session)).status, 200);

  const done = await logout({ Origin: publicOrigin, "X-Compass-CSRF": csrfToken });
  assert.equal(done.status, 204);
  assert.match(setCookies(done).find((line) => line.startsWith("__Host-compass_session="))!, /Max-Age=0/);
  assert.equal((await getSession(ctx, session)).status, 401);
  // 取消済み・Session無しでも冪等に204。
  assert.equal((await logout({})).status, 204);
  assert.equal((await ctx.app.request("/api/auth/logout", { method: "POST" })).status, 204);
  const revoked = await ctx.database.selectFrom("web_session").select("revoke_reason").executeTakeFirstOrThrow();
  assert.equal(revoked.revoke_reason, "logout");
  await ctx.database.destroy();
});

test("Session無し・未知・アイドル期限切れは401で、Sessionはserver再起動後も検証できる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-oidc-"));
  const path = join(directory, "compass.db");
  try {
    const ctx = await setup({ path });
    const { session } = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
    const unauthenticated = await getSession(ctx, undefined);
    assert.equal(unauthenticated.status, 401);
    assert.equal(((await unauthenticated.json()) as { error: { code: string } }).error.code, "UNAUTHENTICATED");
    assert.equal((await getSession(ctx, "unknown-token")).status, 401);
    await ctx.database.destroy();

    const restarted = await setup({ path });
    restarted.clock.now = ctx.clock.now + 60 * 1000;
    assert.equal((await getSession(restarted, session)).status, 200);
    restarted.clock.now += sessionIdleTtlMs + 1;
    assert.equal((await getSession(restarted, session)).status, 401);
    await restarted.database.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JWKSはcacheし、未知のkid（鍵rotation）では1回だけ再取得する", async () => {
  const ctx = await setup();
  await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
  await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
  assert.equal(ctx.fixture.jwksFetches, 1);

  ctx.fixture.rotate();
  const rotated = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
  assert.equal(rotated.callback.headers.get("Location"), "/");
  assert.equal(ctx.fixture.jwksFetches, 2);

  // 再取得しても見つからないkidは拒否する（1回の検証で再取得は1回だけ）。
  const unknown = await loginFlow(ctx, {
    subject: "owner-sub",
    email: ownerEmail,
    tamper: (token) => {
      const [, payload, signature] = token.split(".");
      return `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "missing" })).toString("base64url")}.${payload}.${signature}`;
    },
  });
  assert.equal(unknown.callback.headers.get("Location"), "/login?error=oidc_failed");
  assert.equal(ctx.fixture.jwksFetches, 3);
  await ctx.database.destroy();
});

test("Google token・code・state・Session secret・client secretをDB平文・request log・応答へ出さない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-oidc-secret-"));
  const path = join(directory, "compass.db");
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const ctx = await setup({ path });
    const success = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail });
    const failure = await loginFlow(ctx, { subject: "owner-sub", email: ownerEmail, claims: { aud: "other" } });
    const session = await getSession(ctx, success.session);
    const responses = [
      success.callback.headers.get("Location"),
      failure.callback.headers.get("Location"),
      await session.text(),
      await failure.callback.text(),
    ].join("\n");
    await ctx.database.destroy();

    const secrets = [
      success.session!,
      success.code,
      success.attempt,
      success.authorization.searchParams.get("state")!,
      success.authorization.searchParams.get("nonce")!,
      clientSecret,
      "ya29.access-token-DO-NOT-LEAK",
      ...ctx.fixture.issuedIdTokens,
    ];
    const databaseText = (await readFile(path)).toString("latin1") + (await readFile(`${path}-wal`).catch(() => Buffer.from(""))).toString("latin1");
    for (const secret of secrets) {
      assert.equal(databaseText.includes(secret), false, "DB contains a secret");
      assert.equal(logs.join("\n").includes(secret), false, `log contains a secret: ${logs.filter((l) => l.includes(secret)).join(" | ")}`);
      assert.equal(responses.includes(secret), false, "response contains a secret");
    }
    assert.ok(logs.some((line) => line.includes("/auth/google/callback")), "request log is captured");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted-localだけでLocalDevIdentityProviderのログインを登録し、remoteでは経路が無い", async () => {
  const local = await setup({ mode: "trusted-local" });
  const login = (ctx: Setup, email: string) =>
    ctx.app.request("/auth/local/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ctx.origin },
      body: new URLSearchParams({ email, returnTo: "/projects" }).toString(),
    });
  const methods = async (ctx: Setup) => (await ctx.app.request("/api/auth/methods")).json();
  assert.deepEqual(await methods(local), { google: true, local: true });
  const stranger = await login(local, "stranger@example.com");
  assert.equal(stranger.headers.get("Location"), "/login?error=not_allowed");
  assert.deepEqual(await countRows(local.database), noRows);

  const owner = await login(local, ownerEmail);
  assert.equal(owner.headers.get("Location"), "/projects");
  const line = setCookies(owner).find((cookie) => cookie.startsWith("compass_session="))!;
  assert.match(line, /HttpOnly/);
  assert.doesNotMatch(line, /Secure/);
  const identity = await local.database.selectFrom("human_identity").selectAll().executeTakeFirstOrThrow();
  assert.deepEqual([identity.provider, identity.issuer, identity.subject], ["local", "urn:compass:local", ownerEmail]);
  assert.equal((await getSession(local, cookieValue(owner, "compass_session"))).status, 200);
  await local.database.destroy();

  const remote = await setup();
  assert.deepEqual(await methods(remote), { google: true, local: false });
  assert.equal((await login(remote, ownerEmail)).status, 404);
  assert.deepEqual(await countRows(remote.database), noRows);
  await remote.database.destroy();
});

test("設定: remoteの必須値欠落・https以外・不正modeと、trusted-localの非loopback bind・production実行で起動を拒否する（値を出さない）", () => {
  const remote = {
    COMPASS_PUBLIC_ORIGIN: publicOrigin,
    COMPASS_GOOGLE_CLIENT_ID: clientId,
    COMPASS_GOOGLE_CLIENT_SECRET: clientSecret,
  };
  const config = loadHumanAuthConfig(remote, { port: 51800 });
  assert.equal(config.mode, "remote");
  assert.equal(config.host, undefined);
  assert.deepEqual(config.google, { clientId, clientSecret, redirectUri });

  const rejects = (env: NodeJS.ProcessEnv, pattern: RegExp) =>
    assert.throws(() => loadHumanAuthConfig(env, { port: 51800 }), (error: unknown) => {
      assert.ok(error instanceof HumanAuthConfigError);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(clientSecret), false);
      return true;
    });
  rejects({}, /COMPASS_PUBLIC_ORIGIN is required/);
  rejects({ ...remote, COMPASS_PUBLIC_ORIGIN: "http://compass.example.com" }, /https/);
  rejects({ ...remote, COMPASS_PUBLIC_ORIGIN: "https://compass.example.com/app" }, /origin without path/);
  rejects({ ...remote, COMPASS_GOOGLE_CLIENT_SECRET: "" }, /COMPASS_GOOGLE_CLIENT_SECRET/);
  rejects({ ...remote, COMPASS_AUTH_MODE: "anonymous" }, /COMPASS_AUTH_MODE/);
  rejects({ ...remote, COMPASS_REGISTRATION_MODE: "open" }, /closed/);
  rejects({ COMPASS_AUTH_MODE: "trusted-local", COMPASS_HOST: "0.0.0.0" }, /loopback/);
  rejects({ COMPASS_AUTH_MODE: "trusted-local", COMPASS_GOOGLE_CLIENT_ID: clientId }, /set together/);
  rejects({ NODE_ENV: "production", COMPASS_AUTH_MODE: "trusted-local", COMPASS_INITIAL_OWNER_EMAIL: ownerEmail }, /production/);
  rejects({ NODE_ENV: " production ", COMPASS_AUTH_MODE: "trusted-local" }, /production/);
  assert.equal(loadHumanAuthConfig({ ...remote, NODE_ENV: "production" }, { port: 51800 }).mode, "remote");

  const local = loadHumanAuthConfig({ COMPASS_AUTH_MODE: "trusted-local" }, { port: 52000 });
  assert.deepEqual([local.host, local.publicOrigin, local.google], ["127.0.0.1", "http://localhost:52000", null]);

  assert.throws(() => assertBootstrapConfigured(config, { platformOwnerExists: false }), /COMPASS_INITIAL_OWNER_EMAIL/);
  assert.doesNotThrow(() => assertBootstrapConfigured(config, { platformOwnerExists: true }));
  assert.doesNotThrow(() =>
    assertBootstrapConfigured({ ...config, initialOwnerEmail: ownerEmail }, { platformOwnerExists: false }),
  );
});
