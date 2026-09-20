import { principalIdSchema } from "../../shared/projectGrantSchema.ts";
import type { Principal } from "../../application/service/ProjectAuthorizationService.ts";

export class MalformedAuthorizationError extends Error {
  constructor() {
    super("Authorization: Bearer <AgentName> is malformed");
    this.name = "MalformedAuthorizationError";
  }
}

/**
 * Authorizationヘッダーから、trusted-localのPrincipal（Bearerの値そのもの）を解決する。
 * ヘッダーが無ければPrincipalなし。有るのに形式が不正なら、anonymousへ黙って降格せず拒否する。
 * Principalの規則はGrantのprincipalIdと同じ（shared/projectGrantSchema）。将来の認証adapterはここだけを差し替える。
 */
export const resolvePrincipal = (authorization: string | null): Principal => {
  if (authorization === null) return null;
  const match = /^bearer\s+(\S.*)$/i.exec(authorization.trim());
  const parsed = match ? principalIdSchema.safeParse(match[1]) : null;
  if (!parsed?.success) throw new MalformedAuthorizationError();
  return parsed.data;
};
