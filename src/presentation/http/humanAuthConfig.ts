import type { GoogleOidcSettings } from "../../infrastructure/identity/GoogleOidcIdentityProvider.ts";

export type AuthMode = "remote" | "trusted-local";

/** 起動時に確定するHuman認証の設定（docs/step-6-human-auth-design.md「設定」）。 */
export type HumanAuthConfig = {
  mode: AuthMode;
  /** CSRFのOrigin照合とredirect URIの基準。末尾`/`なしのorigin。 */
  publicOrigin: string;
  /** listenするhost。trusted-localはloopbackだけ。remoteで未指定なら全interface。 */
  host: string | undefined;
  google: GoogleOidcSettings | null;
  initialOwnerEmail: string | null;
};

/** 設定不正。messageに環境変数の名前だけを含め、値（secret）を含めない。 */
export class HumanAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanAuthConfigError";
  }
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

const text = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const parseOrigin = (value: string, name: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HumanAuthConfigError(`${name} must be an absolute URL`);
  }
  if (url.origin === "null" || url.href !== `${url.origin}/`) {
    throw new HumanAuthConfigError(`${name} must be an origin without path, query or fragment`);
  }
  return url;
};

/**
 * 環境変数からHuman認証の設定を読み、不正ならfail-fastする。既定は`remote`で、
 * `trusted-local`は明示設定かつloopback bindのときだけ許し、`NODE_ENV=production`では拒否する。
 */
export const loadHumanAuthConfig = (env: NodeJS.ProcessEnv, options: { port: number }): HumanAuthConfig => {
  const mode = text(env.COMPASS_AUTH_MODE) ?? "remote";
  if (mode !== "remote" && mode !== "trusted-local") {
    throw new HumanAuthConfigError("COMPASS_AUTH_MODE must be remote or trusted-local");
  }
  if (mode === "trusted-local" && text(env.NODE_ENV) === "production") {
    throw new HumanAuthConfigError("COMPASS_AUTH_MODE=trusted-local is not allowed when NODE_ENV is production");
  }
  if ((text(env.COMPASS_REGISTRATION_MODE) ?? "closed") !== "closed") {
    throw new HumanAuthConfigError("COMPASS_REGISTRATION_MODE supports only closed");
  }
  const host = text(env.COMPASS_HOST) ?? (mode === "trusted-local" ? "127.0.0.1" : undefined);
  if (mode === "trusted-local" && !loopbackHosts.has(host ?? "")) {
    throw new HumanAuthConfigError("COMPASS_HOST must be a loopback address in trusted-local mode");
  }

  const originValue = text(env.COMPASS_PUBLIC_ORIGIN);
  if (mode === "remote" && originValue === null) {
    throw new HumanAuthConfigError("COMPASS_PUBLIC_ORIGIN is required in remote mode");
  }
  const origin = parseOrigin(originValue ?? `http://localhost:${options.port}`, "COMPASS_PUBLIC_ORIGIN");
  if (mode === "remote" && origin.protocol !== "https:") {
    throw new HumanAuthConfigError("COMPASS_PUBLIC_ORIGIN must use https in remote mode");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new HumanAuthConfigError("COMPASS_PUBLIC_ORIGIN must use http or https");
  }

  const clientId = text(env.COMPASS_GOOGLE_CLIENT_ID);
  const clientSecret = text(env.COMPASS_GOOGLE_CLIENT_SECRET);
  if (mode === "remote" && (clientId === null || clientSecret === null)) {
    throw new HumanAuthConfigError("COMPASS_GOOGLE_CLIENT_ID and COMPASS_GOOGLE_CLIENT_SECRET are required in remote mode");
  }
  if ((clientId === null) !== (clientSecret === null)) {
    throw new HumanAuthConfigError("COMPASS_GOOGLE_CLIENT_ID and COMPASS_GOOGLE_CLIENT_SECRET must be set together");
  }

  return {
    mode,
    publicOrigin: origin.origin,
    host,
    google:
      clientId && clientSecret
        ? { clientId, clientSecret, redirectUri: `${origin.origin}/auth/google/callback` }
        : null,
    initialOwnerEmail: text(env.COMPASS_INITIAL_OWNER_EMAIL),
  };
};

/** platform ownerが未作成なのに初期owner emailが無ければ、だれもログインできないため起動を拒否する。 */
export const assertBootstrapConfigured = (config: HumanAuthConfig, status: { platformOwnerExists: boolean }) => {
  if (!status.platformOwnerExists && config.initialOwnerEmail === null) {
    throw new HumanAuthConfigError("COMPASS_INITIAL_OWNER_EMAIL is required until the initial owner signs in");
  }
};
