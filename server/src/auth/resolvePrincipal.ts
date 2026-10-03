import {
  looksLikeCredentialToken,
  principalIdSchema,
  projectRoles,
  type ProjectRole,
  type AgentCredentialCaller,
  type Caller,
  type Principal,
  type RuntimeCredentialCaller,
} from "@compass/access";
import { UnauthenticatedError, ValidationError } from "@compass/shared";
import type { AuthMode } from "./humanAuthConfig.ts";

export class MalformedAuthorizationError extends Error {
  constructor() {
    super("Authorization: Bearer <AgentName> is malformed");
    this.name = "MalformedAuthorizationError";
  }
}

const bearerValue = (authorization: string): string => {
  const match = /^bearer\s+(\S.*)$/i.exec(authorization.trim());
  if (!match) throw new MalformedAuthorizationError();
  return match[1].trim();
};

/**
 * Authorizationヘッダーから、trusted-localのPrincipal（Bearerの値そのもの）を解決する。
 * ヘッダーが無ければPrincipalなし。有るのに形式が不正なら、anonymousへ黙って降格せず拒否する。
 * Principalの規則はGrantのprincipalIdと同じ（shared/projectGrantSchema）。
 */
export const resolvePrincipal = (authorization: string | null): Principal => {
  if (authorization === null) return null;
  const parsed = principalIdSchema.safeParse(bearerValue(authorization));
  if (!parsed.success) throw new MalformedAuthorizationError();
  return parsed.data;
};

/**
 * MCP・Runtime向けAPIの呼出し主体を解決する（Task 37）。Session Cookieは読まない。
 * - `cmp_`で始まるBearerは、modeによらずAgent / Runtime Credentialとして検証する（不正ならUNAUTHENTICATED。Agent名へ降格しない）。
 * - それ以外のBearer（Agent名の自己申告）は、明示的なtrusted-local modeだけで受け付ける。remote modeではUNAUTHENTICATED。
 */
export const resolveCaller = async (
  authorization: string | null,
  mode: AuthMode,
  authenticate: (token: string) => Promise<AgentCredentialCaller | RuntimeCredentialCaller>,
): Promise<Caller> => {
  if (authorization === null) return null;
  const value = bearerValue(authorization);
  if (looksLikeCredentialToken(value)) return authenticate(value);
  if (mode === "remote") {
    throw new UnauthenticatedError("remote mode requires an Agent or Runtime Credential issued by Compass");
  }
  return resolvePrincipal(authorization);
};

/** 操作Contextに固定するRoleを渡すrequest header（MCP・Runtime向けAPI）。 */
export const ACTIVE_ROLE_HEADER = "X-Compass-Active-Role";

/**
 * `X-Compass-Active-Role`を解決する。無ければnull（互換: 操作ごとに必要Roleを検査）。
 * 既存のRole名以外は、Roleなしへ黙って降格せずVALIDATION_ERRORにする。Grantの有無はProjectごとに認可serviceが検査する。
 */
export const resolveActiveRole = (header: string | null): ProjectRole | null => {
  if (header === null) return null;
  const value = header.trim();
  const role = projectRoles.find((candidate) => candidate === value);
  if (role === undefined) {
    throw new ValidationError(`${ACTIVE_ROLE_HEADER} is invalid`, [
      { path: ACTIVE_ROLE_HEADER, message: `must be one of ${projectRoles.join(", ")}` },
    ]);
  }
  return role;
};
