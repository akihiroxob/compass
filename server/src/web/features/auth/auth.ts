// テストからも読み込むため、他moduleをimportしない純関数だけを置く。
export type SessionHuman = { id: string; displayName: string; email: string };
export type SessionInfo = { human: SessionHuman; csrfToken: string; expiresAt: number };
/** `GET /api/auth/methods`。ログイン画面が出すフォームの選択に使う。 */
export type AuthMethods = { google: boolean; local: boolean };

export const sessionPath = "/api/auth/session";
export const methodsPath = "/api/auth/methods";
export const logoutPath = "/api/auth/logout";

/**
 * `/login?error=<code>`の表示文言。serverの3種（docs/step-6-human-auth-design.md「拒否応答」）に、
 * 画面側のSession切れを加える。Project名・招待先email・Humanの有無は出さない。
 */
export const loginErrorMessages: Record<string, { title: string; detail: string }> = {
  not_allowed: {
    title: "このアカウントではCompassを利用できません。",
    detail: "招待を受けている場合は、招待されたメールアドレスのアカウントで、受け取った招待リンクからログインしてください。",
  },
  invitation_expired: {
    title: "招待の有効期限が切れています。",
    detail: "Projectのownerに招待の再発行を依頼してください。",
  },
  oidc_failed: {
    title: "Googleでのログインを完了できませんでした。",
    detail: "時間をおいてもう一度ログインしてください。",
  },
  session_expired: {
    title: "ログインの有効期限が切れました。",
    detail: "もう一度ログインしてください。",
  },
};

const unknownLoginError = { title: "ログインできませんでした。", detail: "もう一度ログインしてください。" };

export const loginErrorMessage = (code: string | null) =>
  code === null ? null : (loginErrorMessages[code] ?? unknownLoginError);

/**
 * ログイン後の遷移先。同一origin内の相対pathだけを使い、それ以外は`/`（serverも同じ規則で検査する）。
 * ログイン画面・招待画面自体へは戻さない。
 */
export const normalizeReturnTo = (value: string | null | undefined): string => {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  if (/^\/(login|invite)(?:[/?#]|$)/.test(value)) return "/";
  return value;
};

export const loginPath = (returnTo: string, error?: string) => {
  const params = new URLSearchParams();
  const normalized = normalizeReturnTo(returnTo);
  if (normalized !== "/") params.set("returnTo", normalized);
  if (error) params.set("error", error);
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
};

/** 招待リンク`/invite#<token>`のfragmentからtokenを取り出す（fragmentはserverへ送られない）。 */
export const readInvitationToken = (hash: string): string | null => {
  const token = hash.startsWith("#") ? hash.slice(1) : hash;
  return /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : null;
};
