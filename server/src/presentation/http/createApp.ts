import { createHttpRequestContext } from "./httpRequestContext.ts";
import { registerOrganizationRoutes } from "./registerOrganizationRoutes.ts";
import { registerDirectionRoutes } from "./registerDirectionRoutes.ts";
import { registerAccessRoutes } from "./registerAccessRoutes.ts";
import { registerRuntimeRoutes } from "./registerRuntimeRoutes.ts";
import { registerWorkRoutes } from "./registerWorkRoutes.ts";
import { registerActivityRoutes } from "./registerActivityRoutes.ts";
import { registerCollaborationRoutes } from "./registerCollaborationRoutes.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createMcpServer } from "../../mcp/createMcpServer.ts";
import { ACTIVE_ROLE_HEADER, MalformedAuthorizationError } from "../../auth/resolvePrincipal.ts";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@compass/shared";
import { CoordinationError } from "@compass/work";
import type { ApplicationServices } from "../../application/ApplicationServices.ts";
import { CsrfRejectedError, registerHumanAuthRoutes, type HumanAuthHttpOptions } from "../../auth/registerHumanAuthRoutes.ts";

export const createApp = (
  services: ApplicationServices,
  /** Human認証（Session Cookie・`/auth/*`）。server起動時は設定から必ず渡す。無ければ認証routeを登録しない。 */
  options: {
    humanAuth?: HumanAuthHttpOptions;
    /** 実行環境に応じたWeb UI配信。API・MCPの処理後だけ呼び出す。 */
    staticAssets?: { files: MiddlewareHandler; index: MiddlewareHandler };
  } = {},
) => {
  const app = new Hono();

  // OIDC callbackのcode / state等をrequest logへ残さないよう、`/auth/*`のquery文字列を伏せる。
  app.use(logger((message, ...rest) => console.log(message.replace(/(\/auth\/\S*?)\?\S*/, "$1?[redacted]"), ...rest)));
  // Bearerで呼ぶMCP・Runtime向けAPIだけにCORSを許す。Session Cookieで認証するHuman向け`/api/*`は他originから呼ばせない。
  const bearerCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type", ACTIVE_ROLE_HEADER] });
  for (const path of [
    "/mcp",
    "/api/workspaces/:workspaceId/runtime-events",
    "/api/workspaces/:workspaceId/runtime-events/*",
    "/api/projects/:projectId/outcomes/:outcomeId/execution-evidence",
    "/api/projects/:projectId/publications",
  ]) {
    app.use(path, bearerCors);
  }

  app.get("/health", (c) => c.json({ status: "ok", service: "compass" }));
  app.get("/api", (c) => c.json({ service: "compass", status: "ok" }));
  if (options.humanAuth) registerHumanAuthRoutes(app, services, options.humanAuth);
  const context = createHttpRequestContext(services, options);
  const { callerOf, operationServicesOf, humanAuth } = context;
  registerOrganizationRoutes(app, context);
  registerDirectionRoutes(app, context);
  registerAccessRoutes(app, context);
  registerRuntimeRoutes(app, context);
  registerWorkRoutes(app, context);
  registerActivityRoutes(app, context);
  registerCollaborationRoutes(app, context);
  app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not Found" } }, 404));

  app.all("/mcp", async (c) => {
    // 呼出し主体はこのrequestのヘッダーだけから解決する（MCPはstateless）。形式不正・無効なCredential・
    // remote modeのAgent名Bearerはtoolへ進めず401にする。
    let caller;
    try {
      caller = await callerOf(c);
    } catch (error) {
      if (!(error instanceof MalformedAuthorizationError || error instanceof UnauthenticatedError)) throw error;
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: error.message }, id: null }, 401);
    }
    // activeRoleもこのrequestのヘッダーだけから解決する。不正な値はRoleなしへ降格せず400にする。
    let operationServices;
    try {
      operationServices = operationServicesOf(c);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return c.json({ jsonrpc: "2.0", error: { code: -32602, message: error.message }, id: null }, 400);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer(operationServices, caller, { mode: humanAuth.mode });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  if (options.staticAssets) {
    app.use("/*", options.staticAssets.files);
    app.get("*", options.staticAssets.index);
  }

  app.onError((error, c) => {
    if (error instanceof ValidationError) {
      return c.json(
        { error: { code: error.code, message: error.message, issues: error.issues } },
        400,
      );
    }
    if (error instanceof NotFoundError) {
      return c.json({ error: { code: error.code, message: error.message } }, 404);
    }
    if (error instanceof ConflictError) {
      return c.json(
        { error: { code: error.code, message: error.message, ...error.details } },
        409,
      );
    }
    if (error instanceof UnauthenticatedError) {
      return c.json({ error: { code: error.code, message: error.message } }, 401);
    }
    // Bearerの形式不正は、Principalなしへ降格せず拒否する（MCPと同じ扱い）。
    if (error instanceof MalformedAuthorizationError) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: error.message } }, 401);
    }
    if (error instanceof CsrfRejectedError) {
      return c.json({ error: { code: error.code, message: error.message } }, 403);
    }
    if (error instanceof ForbiddenError) {
      return c.json({ error: { code: error.code, message: error.message, ...error.details } }, 403);
    }
    // Web API・Runtime向けAPIで外部（GitHub）の事実を確認できなかった失敗。読めなければ503（retryable）、権限の不足は502。
    if (error instanceof CoordinationError && (error.code === "GITHUB_UNAVAILABLE" || error.code === "GITHUB_ACCESS_DENIED")) {
      return c.json({ error: error.toJSON() }, error.code === "GITHUB_UNAVAILABLE" ? 503 : 502);
    }
    console.error(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal Server Error" } }, 500);
  });

  return app;
};
