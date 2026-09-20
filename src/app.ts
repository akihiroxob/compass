import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "./presentation/mcp/createMcpServer.ts";
import { MalformedAuthorizationError, resolvePrincipal } from "./presentation/mcp/resolvePrincipal.ts";
import { ConflictError } from "./application/error/ConflictError.ts";
import { ForbiddenError } from "./application/error/ForbiddenError.ts";
import { NotFoundError } from "./application/error/NotFoundError.ts";
import { UnauthenticatedError } from "./application/error/UnauthenticatedError.ts";
import { ValidationError } from "./application/error/ValidationError.ts";
import { applicationServices, type ApplicationServices } from "./container.ts";

export const createApp = (services: ApplicationServices = applicationServices) => {
  const app = new Hono();
  const publicRoot = fileURLToPath(new URL("../public", import.meta.url));

  app.use(logger());
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"] }));

  app.get("/health", (c) => c.json({ status: "ok", service: "compass" }));
  app.get("/api", (c) => c.json({ service: "compass", status: "ok" }));
  const readJsonBody = (request: Request, subject = "Project") =>
    request.json().catch(() => {
      throw new ValidationError(`${subject} input is invalid`, [
        { path: "", message: "request body must be valid JSON" },
      ]);
    });

  app.post("/api/projects", async (c) => {
    const input = await readJsonBody(c.req.raw);
    const project = await services.createProjectUseCase.execute(input);
    return c.json({ project }, 201);
  });
  app.get("/api/projects", async (c) =>
    c.json({ projects: await services.listProjectsUseCase.execute() }),
  );
  app.get("/api/projects/:projectId", async (c) =>
    c.json({ project: await services.getProjectUseCase.execute(c.req.param("projectId")) }),
  );
  app.patch("/api/projects/:projectId", async (c) => {
    const input = await readJsonBody(c.req.raw);
    const project = await services.updateProjectUseCase.execute(c.req.param("projectId"), input);
    return c.json({ project });
  });

  app.post("/api/projects/:projectId/intents", async (c) => {
    const input = await readJsonBody(c.req.raw, "Intent");
    const intent = await services.createIntentUseCase.execute(c.req.param("projectId"), input);
    return c.json({ intent }, 201);
  });
  app.get("/api/projects/:projectId/intents", async (c) =>
    c.json({ intents: await services.listIntentsUseCase.execute(c.req.param("projectId")) }),
  );
  app.get("/api/projects/:projectId/intents/:intentId", async (c) =>
    c.json({
      intent: await services.getIntentUseCase.execute(c.req.param("projectId"), c.req.param("intentId")),
    }),
  );
  app.patch("/api/projects/:projectId/intents/:intentId", async (c) => {
    const input = await readJsonBody(c.req.raw, "Intent");
    const intent = await services.updateIntentUseCase.execute(
      c.req.param("projectId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ intent });
  });
  app.post("/api/projects/:projectId/intents/:intentId/abandon", async (c) => {
    // 放棄理由は任意のため、本文なしの要求は理由なしとして扱う。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Intent") : {};
    const intent = await services.abandonIntentUseCase.execute(
      c.req.param("projectId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ intent });
  });

  const outcomesPath = "/api/projects/:projectId/intents/:intentId/outcomes";
  app.post(outcomesPath, async (c) => {
    const input = await readJsonBody(c.req.raw, "Outcome");
    const outcome = await services.createOutcomeUseCase.execute(
      c.req.param("projectId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ outcome }, 201);
  });
  app.get(outcomesPath, async (c) =>
    c.json({
      outcomes: await services.listOutcomesUseCase.execute(c.req.param("projectId"), c.req.param("intentId")),
    }),
  );
  app.get(`${outcomesPath}/:outcomeId`, async (c) =>
    c.json({
      outcome: await services.getOutcomeUseCase.execute(
        c.req.param("projectId"),
        c.req.param("intentId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  app.patch(`${outcomesPath}/:outcomeId`, async (c) => {
    const input = await readJsonBody(c.req.raw, "Outcome");
    const outcome = await services.updateOutcomeUseCase.execute(
      c.req.param("projectId"),
      c.req.param("intentId"),
      c.req.param("outcomeId"),
      input,
    );
    return c.json({ outcome });
  });
  app.post(`${outcomesPath}/:outcomeId/cancel`, async (c) => {
    // 本文なしの要求は、理由なしとしてuse caseのVALIDATION_ERRORにする。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Outcome") : {};
    const outcome = await services.cancelOutcomeUseCase.execute(
      c.req.param("projectId"),
      c.req.param("intentId"),
      c.req.param("outcomeId"),
      input,
    );
    return c.json({ outcome });
  });
  const grantsPath = "/api/projects/:projectId/grants";
  app.post(grantsPath, async (c) => {
    const input = await readJsonBody(c.req.raw, "Grant");
    const { grant, created } = await services.grantProjectRoleUseCase.execute(c.req.param("projectId"), input);
    return c.json({ grant, created }, created ? 201 : 200);
  });
  app.get(grantsPath, async (c) =>
    c.json({ grants: await services.listProjectGrantsUseCase.execute(c.req.param("projectId")) }),
  );
  // 取消は冪等に扱うため、Grantの特定はbodyでなくpathに置く（principalIdはURLエンコード）。
  app.delete(`${grantsPath}/:role/:principalId`, async (c) => {
    const revoked = await services.revokeProjectRoleUseCase.execute(c.req.param("projectId"), {
      role: c.req.param("role"),
      principalId: c.req.param("principalId"),
    });
    return c.json({ revoked });
  });
  app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not Found" } }, 404));

  app.all("/mcp", async (c) => {
    // Principalはこのrequestのヘッダーだけから解決する（MCPはstateless）。形式不正はtoolへ進めず401にする。
    let principal;
    try {
      principal = resolvePrincipal(c.req.header("Authorization") ?? null);
    } catch (error) {
      if (!(error instanceof MalformedAuthorizationError)) throw error;
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: error.message }, id: null }, 401);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer(services, principal);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.use("/*", serveStatic({ root: publicRoot }));
  app.get("*", serveStatic({ root: publicRoot, path: "index.html" }));

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
    if (error instanceof ForbiddenError) {
      return c.json({ error: { code: error.code, message: error.message, ...error.details } }, 403);
    }
    console.error(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal Server Error" } }, 500);
  });

  return app;
};
