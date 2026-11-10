import type { Context } from "hono";
import { ValidationError } from "@compass/shared";
import type { ApplicationServices } from "../../application/ApplicationServices.ts";
import { ACTIVE_ROLE_HEADER, resolveActiveRole, resolveCaller } from "../../auth/resolvePrincipal.ts";
import { requireHumanSession, type HumanAuthHttpOptions } from "../../auth/registerHumanAuthRoutes.ts";

export const createHttpRequestContext = (services: ApplicationServices, options: { humanAuth?: HumanAuthHttpOptions }) => {
  const readJsonBody = (request: Request, subject = "Project") =>
    request.json().catch(() => {
      throw new ValidationError(`${subject} input is invalid`, [
        { path: "", message: "request body must be valid JSON" },
      ]);
    });

  // Human向け`/api/*`は常にSessionを要求する。設定が渡されない場合（MCP等のテスト）もSessionの検査は省かず、
  // trusted-localのCookie名とloopbackのoriginで検査する（認証routeは登録しないため、Sessionは作れない）。
  const humanAuth = options.humanAuth ?? { mode: "trusted-local", publicOrigin: "http://localhost" };
  const actorOf = async (c: Context) => (await requireHumanSession(c, services, humanAuth)).actor;
  // MCP・Runtime向けAPIの呼出し主体（Task 37）。Session Cookieは読まず、BearerのCredential（trusted-localだけAgent名も）で解決する。
  const callerOf = (c: Context) =>
    resolveCaller(c.req.header("Authorization") ?? null, humanAuth.mode, (token) =>
      services.authenticateAccessCredentialUseCase.execute(token),
    );
  // 操作ContextのactiveRole（docs/architecture-migration-mapping.md）。headerがあればそのRoleのGrantだけで認可するserviceを使う。
  // headerなしは互換として従来のservice（操作ごとに必要Roleを検査）。Human向け`/api/*`はMembershipで認可し、headerを読まない。
  const operationServicesOf = (c: Context) => {
    const activeRole = resolveActiveRole(c.req.header(ACTIVE_ROLE_HEADER) ?? null);
    return activeRole === null ? services : services.forActiveRole(activeRole);
  };
  const { human } = services;
  return { services, human, humanAuth, actorOf, callerOf, operationServicesOf, readJsonBody };
};
export type HttpRequestContext = ReturnType<typeof createHttpRequestContext>;
