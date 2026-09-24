import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { VerifiedIdentity } from "../../domain/model/HumanAuth.ts";
import { IdentityVerificationError, type HumanIdentityProvider } from "../../application/port/HumanIdentityProvider.ts";

export const googleIssuer = "https://accounts.google.com";
const acceptedIssuers = new Set([googleIssuer, "accounts.google.com"]);
const clockSkewMs = 60 * 1000;
/** JWKS応答に`Cache-Control: max-age`が無いときのcache期間。 */
const defaultJwksCacheMs = 5 * 60 * 1000;
const requestTimeoutMs = 10 * 1000;

export type GoogleOidcSettings = {
  clientId: string;
  clientSecret: string;
  /** `${COMPASS_PUBLIC_ORIGIN}/auth/google/callback`。requestのHostから組み立てない。 */
  redirectUri: string;
};

/** endpointとfetchは自動テストでOIDC fixtureへ差し替えるためだけに注入できる（envからは選べない）。 */
export type GoogleOidcDependencies = {
  fetch?: typeof fetch;
  clock?: () => number;
  endpoints?: { authorization: string; token: string; jwks: string };
};

const googleEndpoints = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
};

const fail = (message: string): never => {
  throw new IdentityVerificationError(message);
};

const decodeJsonSegment = (segment: string, name: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 下で同じエラーにする。
  }
  return fail(`ID token ${name} is malformed`);
};

const maxAgeMs = (cacheControl: string | null) => {
  const match = cacheControl ? /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl) : null;
  return match ? Number(match[1]) * 1000 : defaultJwksCacheMs;
};

/**
 * Google Identity Services / OpenID Connect（authorization code + PKCE）。code交換とID Token検証をserverで行い、
 * 検証済みの`VerifiedIdentity`だけを返す。Google access / ID tokenは検証後に破棄し、保存・ログ出力しない。
 * ID TokenはGoogleのJWKSでRS256署名を検証する（node:cryptoのJWK読込とRSA検証を使い、JWTライブラリの依存を足さない）。
 */
export class GoogleOidcIdentityProvider implements HumanIdentityProvider {
  readonly provider = "google" as const;
  private readonly fetch: typeof fetch;
  private readonly clock: () => number;
  private readonly endpoints: { authorization: string; token: string; jwks: string };
  private jwks: { keys: Map<string, KeyObject>; expiresAt: number } | null = null;

  constructor(
    private readonly settings: GoogleOidcSettings,
    dependencies: GoogleOidcDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.clock = dependencies.clock ?? Date.now;
    this.endpoints = dependencies.endpoints ?? googleEndpoints;
  }

  authorizationUrl(request: { state: string; nonce: string; codeChallenge: string }): string {
    const url = new URL(this.endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      response_type: "code",
      // refresh tokenを要求しない（access_type=offlineを付けない）。
      scope: "openid email profile",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  async verifyCallback(input: { code: string; codeVerifier: string; nonce: string }): Promise<VerifiedIdentity> {
    const idToken = await this.exchangeCode(input.code, input.codeVerifier);
    return this.verifyIdToken(idToken, input.nonce);
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          redirect_uri: this.settings.redirectUri,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return fail("token endpoint is unreachable");
    }
    // 応答本文はtokenやcodeを含み得るため、エラーへ転記しない。
    if (!response.ok) return fail(`token exchange failed with status ${response.status}`);
    const body = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
    if (typeof body?.id_token !== "string") return fail("token response has no id_token");
    return body.id_token;
  }

  private async verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
    const segments = idToken.split(".");
    if (segments.length !== 3) return fail("ID token is malformed");
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = decodeJsonSegment(encodedHeader, "header");
    if (header.alg !== "RS256") return fail("ID token algorithm is not RS256");
    if (typeof header.kid !== "string") return fail("ID token has no key id");

    const key = await this.findKey(header.kid);
    const signed = verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!signed) return fail("ID token signature is invalid");

    const claims = decodeJsonSegment(encodedPayload, "payload");
    const now = this.clock();
    if (typeof claims.iss !== "string" || !acceptedIssuers.has(claims.iss)) return fail("ID token issuer is invalid");
    const audience = claims.aud;
    const audienceMatches = Array.isArray(audience)
      ? audience.includes(this.settings.clientId) && claims.azp === this.settings.clientId
      : audience === this.settings.clientId;
    if (!audienceMatches) return fail("ID token audience is invalid");
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now - clockSkewMs) return fail("ID token is expired");
    if (typeof claims.iat !== "number" || claims.iat * 1000 > now + clockSkewMs) return fail("ID token is issued in the future");
    if (typeof claims.nonce !== "string" || claims.nonce !== expectedNonce) return fail("ID token nonce does not match");
    if (typeof claims.sub !== "string" || claims.sub === "") return fail("ID token has no subject");
    if (typeof claims.email !== "string" || claims.email === "") return fail("ID token has no email");

    return {
      provider: "google",
      // `accounts.google.com`と`https://accounts.google.com`を同じIssuerとして保存する。
      issuer: googleIssuer,
      subject: claims.sub,
      email: claims.email,
      // falseは登録規則（#0）で`not_allowed`として拒否する。
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      displayName: typeof claims.name === "string" && claims.name.trim() !== "" ? claims.name.trim() : null,
    };
  }

  /** cache済みのJWKSから探し、未知の`kid`なら1回だけ再取得する。 */
  private async findKey(kid: string): Promise<KeyObject> {
    const now = this.clock();
    if (this.jwks && this.jwks.expiresAt > now) {
      const cached = this.jwks.keys.get(kid);
      if (cached) return cached;
    }
    this.jwks = await this.fetchJwks(now);
    return this.jwks.keys.get(kid) ?? fail("ID token key id is unknown");
  }

  private async fetchJwks(now: number) {
    let response: Response;
    try {
      response = await this.fetch(this.endpoints.jwks, { signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch {
      return fail("JWKS endpoint is unreachable");
    }
    if (!response.ok) return fail(`JWKS request failed with status ${response.status}`);
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!Array.isArray(body?.keys)) return fail("JWKS is malformed");
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys as (JsonWebKey & { kid?: unknown; use?: unknown })[]) {
      if (typeof jwk.kid !== "string" || jwk.kty !== "RSA" || (jwk.use !== undefined && jwk.use !== "sig")) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // 読めない鍵は使わない。
      }
    }
    return { keys, expiresAt: now + maxAgeMs(response.headers.get("cache-control")) };
  }
}
