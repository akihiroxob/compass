import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Session・招待・ログイン試行のsecret。256bitの暗号学的乱数をbase64urlにし、平文は呼出し元へ一度だけ返す。
 * 保存はSHA-256だけ（256bit乱数のため低速hashは不要。DBが漏れても再利用できない）。
 */
export const generateSecretToken = (): string => randomBytes(32).toString("base64url");

export const hashSecretToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** PKCE（S256）のcode_challenge。 */
export const pkceChallenge = (codeVerifier: string): string =>
  createHash("sha256").update(codeVerifier).digest("base64url");

/** CSRF tokenは保存せず、Session secretのHMACで都度導出する（Sessionごとに固定・失効と連動）。 */
export const deriveCsrfToken = (sessionToken: string): string =>
  createHmac("sha256", sessionToken).update("csrf").digest("base64url");

/** 長さの違いも含めて定数時間で比較する。 */
export const secretEquals = (actual: string, expected: string): boolean => {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right) && actual.length === expected.length;
};
