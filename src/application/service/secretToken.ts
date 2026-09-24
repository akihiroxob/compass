import { createHash, randomBytes } from "node:crypto";

/**
 * Session・招待・ログイン試行のsecret。256bitの暗号学的乱数をbase64urlにし、平文は呼出し元へ一度だけ返す。
 * 保存はSHA-256だけ（256bit乱数のため低速hashは不要。DBが漏れても再利用できない）。
 */
export const generateSecretToken = (): string => randomBytes(32).toString("base64url");

export const hashSecretToken = (token: string): string => createHash("sha256").update(token).digest("hex");
