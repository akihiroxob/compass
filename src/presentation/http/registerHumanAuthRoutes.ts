import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { UnauthenticatedError } from "../../application/error/UnauthenticatedError.ts";
import { deriveCsrfToken, secretEquals } from "../../application/service/secretToken.ts";
import type { HumanLoginResult } from "../../application/usecase/HumanLoginUseCases.ts";
import type { ApplicationServices } from "../../createApplicationServices.ts";
import { loginAttemptTtlMs, sessionAbsoluteTtlMs } from "../../domain/model/HumanAuth.ts";
import type { AuthMode } from "./humanAuthConfig.ts";

/** Web層でのHuman認証の設定。Google routeは`services`にOIDCのuse caseがあるときだけ登録する。 */
export type HumanAuthHttpOptions = { mode: AuthMode; publicOrigin: string };

/** CSRF検査・Origin検査の失敗（`403 CSRF_REJECTED`）。 */
export class CsrfRejectedError extends Error {
  readonly code = "CSRF_REJECTED";

  constructor() {
    super("Request origin or CSRF token is invalid");
    this.name = "CsrfRejectedError";
  }
}

/** remoteは`__Host-`（Secure・Path=/・Domainなし）。trusted-localはhttpのためprefixとSecureを付けない。 */
export const sessionCookieName = (mode: AuthMode) => (mode === "remote" ? "__Host-compass_session" : "compass_session");
const loginCookieName = (mode: AuthMode) => (mode === "remote" ? "__Host-compass_login" : "compass_login");

const cookieOptions = (mode: AuthMode, maxAgeMs: number) =>
  ({ httpOnly: true, secure: mode === "remote", sameSite: "Lax", path: "/", maxAge: Math.floor(maxAgeMs / 1000) }) as const;

const clearCookie = (c: Context, name: string, mode: AuthMode) =>
  deleteCookie(c, name, { path: "/", secure: mode === "remote", httpOnly: true, sameSite: "Lax" });

/** `Origin`が公開originと一致すること。`Origin`が無ければ`Sec-Fetch-Site: same-origin`を要求する。 */
const isSameOriginRequest = (c: Context, publicOrigin: string) => {
  const origin = c.req.header("Origin");
  if (origin !== undefined) return origin === publicOrigin;
  return c.req.header("Sec-Fetch-Site") === "same-origin";
};

const requestFormField = (form: Record<string, unknown>, name: string) => {
  const value = form[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * Session Cookieから有効なSessionとHumanを解決する（無ければ`401 UNAUTHENTICATED`。理由は区別しない）。
 * 非安全method（POST / PATCH / PUT / DELETE）では、`X-Compass-CSRF`とOriginも検査する（不一致は`403 CSRF_REJECTED`）。
 * Human向け`/api/*`はこれを通してActorを得る（既存routeへの適用はTask 42）。
 */
export const requireHumanSession = async (c: Context, services: ApplicationServices, options: HumanAuthHttpOptions) => {
  const sessionToken = getCookie(c, sessionCookieName(options.mode));
  const resolved = await services.resolveHumanSessionUseCase.execute(sessionToken);
  if (!resolved || !sessionToken) throw new UnauthenticatedError("A valid session is required");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const csrfToken = c.req.header("X-Compass-CSRF") ?? "";
    if (!isSameOriginRequest(c, options.publicOrigin) || !secretEquals(csrfToken, deriveCsrfToken(sessionToken))) {
      throw new CsrfRejectedError();
    }
  }
  return { ...resolved, sessionToken, actor: { kind: "human", humanUserId: resolved.human.id } as const };
};

/**
 * `/auth/*`（ログイン開始・callback・trusted-localのログイン）と`/api/auth/*`（Session復元・logout）。
 * docs/step-6-human-auth-design.md「Web Session・Cookie・CSRF・OIDCの契約」を参照。
 */
export const registerHumanAuthRoutes = (app: Hono, services: ApplicationServices, options: HumanAuthHttpOptions) => {
  const { mode } = options;

  const finishLogin = (c: Context, result: HumanLoginResult) => {
    c.header("Cache-Control", "no-store");
    if (result.kind === "rejected") return c.redirect(`/login?error=${result.reason}`, 302);
    // ログインごとに新しいSessionを発行する（旧Sessionはuse caseで`superseded`）。
    setCookie(c, sessionCookieName(mode), result.sessionToken, cookieOptions(mode, sessionAbsoluteTtlMs));
    return c.redirect(result.returnTo, 302);
  };

  const readForm = async (c: Context) => {
    if (!isSameOriginRequest(c, options.publicOrigin)) throw new CsrfRejectedError();
    return (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  };

  const { startOidcLoginUseCase, completeOidcLoginUseCase } = services;
  if (startOidcLoginUseCase && completeOidcLoginUseCase) {
    app.post("/auth/google/login", async (c) => {
      const form = await readForm(c);
      const { attemptToken, authorizationUrl } = await startOidcLoginUseCase.execute({
        returnTo: requestFormField(form, "returnTo"),
        invitationToken: requestFormField(form, "invitationToken"),
      });
      setCookie(c, loginCookieName(mode), attemptToken, cookieOptions(mode, loginAttemptTtlMs));
      c.header("Cache-Control", "no-store");
      return c.redirect(authorizationUrl, 302);
    });

    // code / stateはrequest logへ出さない（Honoのloggerはquery文字列を出力しない）。
    app.get("/auth/google/callback", async (c) => {
      const attemptToken = getCookie(c, loginCookieName(mode));
      clearCookie(c, loginCookieName(mode), mode);
      c.header("Referrer-Policy", "no-referrer");
      const result = await completeOidcLoginUseCase.execute({
        attemptToken,
        code: c.req.query("code"),
        state: c.req.query("state"),
        providerError: c.req.query("error"),
        previousSessionToken: getCookie(c, sessionCookieName(mode)),
      });
      return finishLogin(c, result);
    });
  }

  // LocalDevIdentityProviderはtrusted-local（loopback bind）でだけ登録する。remoteでは経路自体が無い。
  if (mode === "trusted-local") {
    app.post("/auth/local/login", async (c) => {
      const form = await readForm(c);
      const result = await services.localDevLoginUseCase.execute({
        email: requestFormField(form, "email"),
        returnTo: requestFormField(form, "returnTo"),
        invitationToken: requestFormField(form, "invitationToken"),
        previousSessionToken: getCookie(c, sessionCookieName(mode)),
      });
      return finishLogin(c, result);
    });
  }

  app.get("/api/auth/session", async (c) => {
    c.header("Cache-Control", "no-store");
    const { human, session, sessionToken } = await requireHumanSession(c, services, options);
    return c.json({
      human: { id: human.id, displayName: human.displayName, email: human.email },
      csrfToken: deriveCsrfToken(sessionToken),
      expiresAt: session.expiresAt,
    });
  });

  // Sessionが無い・無効でも204（冪等）。有効なSessionを取消すときだけCSRFを要求する。
  app.post("/api/auth/logout", async (c) => {
    const sessionToken = getCookie(c, sessionCookieName(mode));
    const resolved = await services.resolveHumanSessionUseCase.execute(sessionToken);
    if (resolved) await requireHumanSession(c, services, options);
    await services.revokeHumanSessionUseCase.execute(sessionToken);
    clearCookie(c, sessionCookieName(mode), mode);
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });
};
