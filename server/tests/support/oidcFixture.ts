import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export type Claims = Record<string, unknown>;

export type OidcFixtureSettings = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  endpoints: { authorization: string; token: string; jwks: string };
};

/**
 * テスト用のOIDC provider（token endpointとJWKS）。本番のGoogleOidcIdentityProviderへfetchとして注入し、
 * code交換（client_secret・redirect_uri・PKCE）とID Token署名を実際に検証させる。
 */
export const createOidcFixture = (clock: { now: number }, settings: OidcFixtureSettings) => {
  const { clientId, clientSecret, redirectUri, endpoints } = settings;
  const newKey = (kid: string) => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } };
  };
  const fixture = {
    keys: [newKey("key-1")],
    jwksFetches: 0,
    tokenRequests: 0,
    issuedIdTokens: [] as string[],
    codes: new Map<string, { claims: Claims; challenge: string; tamper?: (token: string) => string; signWith?: KeyObject; kid?: string }>(),
    rotate() {
      fixture.keys = [newKey(`key-${fixture.keys.length + 1}`)];
    },
    signIdToken(claims: Claims, options: { signWith?: KeyObject; kid?: string } = {}) {
      const key = fixture.keys[0]!;
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: options.kid ?? key.kid, typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signature = sign("sha256", Buffer.from(`${header}.${payload}`), options.signWith ?? key.privateKey).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === endpoints.jwks) {
        fixture.jwksFetches += 1;
        return Response.json({ keys: fixture.keys.map(({ jwk }) => jwk) }, { headers: { "Cache-Control": "public, max-age=3600" } });
      }
      if (url === endpoints.token) {
        fixture.tokenRequests += 1;
        const body = new URLSearchParams(String(init?.body));
        const entry = fixture.codes.get(body.get("code") ?? "");
        const verifier = body.get("code_verifier") ?? "";
        if (
          !entry ||
          body.get("grant_type") !== "authorization_code" ||
          body.get("client_id") !== clientId ||
          body.get("client_secret") !== clientSecret ||
          body.get("redirect_uri") !== redirectUri ||
          createHash("sha256").update(verifier).digest("base64url") !== entry.challenge
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        fixture.codes.delete(body.get("code")!);
        const idToken = fixture.signIdToken(entry.claims, entry);
        const token = entry.tamper ? entry.tamper(idToken) : idToken;
        fixture.issuedIdTokens.push(token);
        return Response.json({ access_token: "ya29.access-token-DO-NOT-LEAK", id_token: token, token_type: "Bearer" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    claims(subject: string, email: string, nonce: string, overrides: Claims = {}): Claims {
      const seconds = Math.floor(clock.now / 1000);
      return {
        iss: "https://accounts.google.com",
        aud: clientId,
        sub: subject,
        email,
        email_verified: true,
        name: "Test User",
        nonce,
        iat: seconds,
        exp: seconds + 3600,
        ...overrides,
      };
    },
  };
  return fixture;
};
