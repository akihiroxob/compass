import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "./presentation/mcp/createMcpServer.ts";
import { MalformedAuthorizationError, resolveCaller } from "./presentation/mcp/resolvePrincipal.ts";
import { ConflictError } from "./application/error/ConflictError.ts";
import { ForbiddenError } from "./application/error/ForbiddenError.ts";
import { NotFoundError } from "./application/error/NotFoundError.ts";
import { UnauthenticatedError } from "./application/error/UnauthenticatedError.ts";
import { ValidationError } from "./application/error/ValidationError.ts";
import { parseProjectStatusFilter } from "./shared/projectSchema.ts";
import { applicationServices, type ApplicationServices } from "./container.ts";
import {
  CsrfRejectedError,
  registerHumanAuthRoutes,
  requireHumanSession,
  type HumanAuthHttpOptions,
} from "./presentation/http/registerHumanAuthRoutes.ts";

export const createApp = (
  services: ApplicationServices = applicationServices,
  /** Human認証（Session Cookie・`/auth/*`）。server起動時は設定から必ず渡す。無ければ認証routeを登録しない。 */
  options: { humanAuth?: HumanAuthHttpOptions } = {},
) => {
  const app = new Hono();
  const publicRoot = fileURLToPath(new URL("../public", import.meta.url));

  // OIDC callbackのcode / state等をrequest logへ残さないよう、`/auth/*`のquery文字列を伏せる。
  app.use(logger((message, ...rest) => console.log(message.replace(/(\/auth\/\S*?)\?\S*/, "$1?[redacted]"), ...rest)));
  // Bearerで呼ぶMCP・Runtime向けAPIだけにCORSを許す。Session Cookieで認証するHuman向け`/api/*`は他originから呼ばせない。
  const bearerCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"] });
  for (const path of [
    "/mcp",
    "/api/projects/:projectId/runtime-events",
    "/api/projects/:projectId/runtime-events/*",
    "/api/projects/:projectId/outcomes/:outcomeId/execution-evidence",
  ]) {
    app.use(path, bearerCors);
  }

  app.get("/health", (c) => c.json({ status: "ok", service: "compass" }));
  app.get("/api", (c) => c.json({ service: "compass", status: "ok" }));
  const readJsonBody = (request: Request, subject = "Project") =>
    request.json().catch(() => {
      throw new ValidationError(`${subject} input is invalid`, [
        { path: "", message: "request body must be valid JSON" },
      ]);
    });

  if (options.humanAuth) registerHumanAuthRoutes(app, services, options.humanAuth);
  // Human向け`/api/*`は常にSessionを要求する。設定が渡されない場合（MCP等のテスト）もSessionの検査は省かず、
  // trusted-localのCookie名とloopbackのoriginで検査する（認証routeは登録しないため、Sessionは作れない）。
  const humanAuth = options.humanAuth ?? { mode: "trusted-local", publicOrigin: "http://localhost" };
  const actorOf = async (c: Context) => (await requireHumanSession(c, services, humanAuth)).actor;
  // MCP・Runtime向けAPIの呼出し主体（Task 37）。Session Cookieは読まず、BearerのCredential（trusted-localだけAgent名も）で解決する。
  const callerOf = (c: Context) =>
    resolveCaller(c.req.header("Authorization") ?? null, humanAuth.mode, (token) =>
      services.authenticateAccessCredentialUseCase.execute(token),
    );
  const { human } = services;

  // 作成者を同一transactionでowner Membershipにする。
  app.post("/api/projects", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw);
    const project = await services.createProjectUseCase.execute(input, actor);
    return c.json({ project }, 201);
  });
  // 有効なMembershipを持つProjectだけ。既定はactiveのみ。`?status=archived`でアーカイブ済み一覧。それ以外の値は400（path `status`）。
  app.get("/api/projects", async (c) => {
    const actor = await actorOf(c);
    return c.json({ projects: await human.listProjects.execute(actor, parseProjectStatusFilter(c.req.query("status"))) });
  });
  // `myRole`はUIの導線切替用。拒否は常にserverの権限表で行う。
  app.get("/api/projects/:projectId", async (c) =>
    c.json(await human.getProject.execute(await actorOf(c), c.req.param("projectId"))),
  );
  app.patch("/api/projects/:projectId", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw);
    const project = await human.updateProject.execute(actor, c.req.param("projectId"), input);
    return c.json({ project });
  });

  // archiveはHuman向けのWeb API専用。MCP tool・CLIコマンドへは公開せず、復帰・削除のAPIも作らない。
  app.post("/api/projects/:projectId/archive", async (c) => {
    const actor = await actorOf(c);
    // 本文なしの要求は、理由なしとしてuse caseのVALIDATION_ERRORにする。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw) : {};
    const project = await human.archiveProject.execute(actor, c.req.param("projectId"), input);
    return c.json({ project });
  });

  app.post("/api/projects/:projectId/intents", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Intent");
    const intent = await human.createIntent.execute(actor, c.req.param("projectId"), input);
    return c.json({ intent }, 201);
  });
  app.get("/api/projects/:projectId/intents", async (c) =>
    c.json({ intents: await human.listIntents.execute(await actorOf(c), c.req.param("projectId")) }),
  );
  app.get("/api/projects/:projectId/intents/:intentId", async (c) =>
    c.json({
      intent: await human.getIntent.execute(await actorOf(c), c.req.param("projectId"), c.req.param("intentId")),
    }),
  );
  app.patch("/api/projects/:projectId/intents/:intentId", async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Intent");
    const intent = await human.updateIntent.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ intent });
  });
  app.post("/api/projects/:projectId/intents/:intentId/abandon", async (c) => {
    const actor = await actorOf(c);
    // 放棄理由は任意のため、本文なしの要求は理由なしとして扱う。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Intent") : {};
    const intent = await human.abandonIntent.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ intent });
  });

  const outcomesPath = "/api/projects/:projectId/intents/:intentId/outcomes";
  app.post(outcomesPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Outcome");
    const outcome = await human.createOutcome.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("intentId"),
      input,
    );
    return c.json({ outcome }, 201);
  });
  app.get(outcomesPath, async (c) =>
    c.json({
      outcomes: await human.listOutcomes.execute(await actorOf(c), c.req.param("projectId"), c.req.param("intentId")),
    }),
  );
  app.get(`${outcomesPath}/:outcomeId`, async (c) =>
    c.json({
      outcome: await human.getOutcome.execute(
        await actorOf(c),
        c.req.param("projectId"),
        c.req.param("intentId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  app.patch(`${outcomesPath}/:outcomeId`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Outcome");
    const outcome = await human.updateOutcome.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("intentId"),
      c.req.param("outcomeId"),
      input,
    );
    return c.json({ outcome });
  });
  app.post(`${outcomesPath}/:outcomeId/cancel`, async (c) => {
    const actor = await actorOf(c);
    // 本文なしの要求は、理由なしとしてuse caseのVALIDATION_ERRORにする。
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Outcome") : {};
    const outcome = await human.cancelOutcome.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("intentId"),
      c.req.param("outcomeId"),
      input,
    );
    return c.json({ outcome });
  });
  const grantsPath = "/api/projects/:projectId/grants";
  app.post(grantsPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Grant");
    const { grant, created } = await human.grantProjectRole.execute(actor, c.req.param("projectId"), input);
    return c.json({ grant, created }, created ? 201 : 200);
  });
  app.get(grantsPath, async (c) =>
    c.json({ grants: await human.listProjectGrants.execute(await actorOf(c), c.req.param("projectId")) }),
  );
  // 取消は冪等に扱うため、Grantの特定はbodyでなくpathに置く（principalIdはURLエンコード）。
  app.delete(`${grantsPath}/:role/:principalId`, async (c) => {
    const actor = await actorOf(c);
    const revoked = await human.revokeProjectRole.execute(actor, c.req.param("projectId"), {
      role: c.req.param("role"),
      principalId: c.req.param("principalId"),
    });
    return c.json({ revoked });
  });
  // Research・Direction Decision・ADR参照はHuman向けの読み取り専用画面（Task 29）。Agent Role Grantではなく
  // Membership（viewer以上）で認可し、MCPのResearcher/Strategist tool群と同じapplication use caseへ委譲する。
  app.get("/api/projects/:projectId/research-requests", async (c) => {
    const actor = await actorOf(c);
    const filter = { originIntentId: c.req.query("originIntentId"), status: c.req.query("status") };
    return c.json({
      requests: await human.listResearchRequests.execute(actor, c.req.param("projectId"), filter),
    });
  });
  app.get("/api/projects/:projectId/research-requests/:requestId", async (c) =>
    c.json({
      detail: await human.getResearchRequest.execute(
        await actorOf(c),
        c.req.param("projectId"),
        c.req.param("requestId"),
      ),
    }),
  );
  app.get("/api/projects/:projectId/intents/:intentId/decisions", async (c) =>
    c.json({
      decisions: await human.listDirectionDecisions.execute(
        await actorOf(c),
        c.req.param("projectId"),
        c.req.param("intentId"),
      ),
    }),
  );
  app.get("/api/projects/:projectId/adr-references", async (c) =>
    c.json({ references: await human.listAdrReferences.execute(await actorOf(c), c.req.param("projectId")) }),
  );
  // 外部Runtime向け。consumerはRuntime Credentialの名前（trusted-localだけBearerのAgent名とruntime Grant）で、発行Projectのイベントだけを扱う。
  // Session Cookieでは認可しない（Human Membershipと混同しない）。
  // 認可・cursor・ackの規則は、MCPと同じapplication層のuse caseが持つ。
  const queryNumber = (value: string | undefined) =>
    value === undefined ? undefined : value.trim() === "" ? Number.NaN : Number(value);
  app.get("/api/projects/:projectId/runtime-events", async (c) =>
    c.json(
      await services.fetchRuntimeEventsUseCase.execute(
        await callerOf(c),
        c.req.param("projectId"),
        { afterCursor: queryNumber(c.req.query("afterCursor")), limit: queryNumber(c.req.query("limit")) },
      ),
    ),
  );
  app.post("/api/projects/:projectId/runtime-events/:eventId/ack", async (c) => {
    const caller = await callerOf(c);
    const input = await readJsonBody(c.req.raw, "Runtime event ack");
    const result = await services.ackRuntimeEventUseCase.execute(caller, c.req.param("projectId"), {
      ...(typeof input === "object" && input !== null ? input : {}),
      eventId: c.req.param("eventId"),
    });
    return c.json(result);
  });
  // ExecutionからDirectionへの還流（Runtime）。結果はExecutionの現在の状態から導出し、Runtimeが渡すのはEvidence参照とcursorだけ。
  app.post("/api/projects/:projectId/outcomes/:outcomeId/execution-evidence", async (c) => {
    const caller = await callerOf(c);
    const input = await readJsonBody(c.req.raw, "Execution evidence");
    return c.json(
      await services.recordExecutionEvidenceUseCase.execute(
        caller,
        c.req.param("projectId"),
        c.req.param("outcomeId"),
        input,
      ),
    );
  });
  // Human向けの読取。還流済みのExecutionの結果・Evidence参照を返す（還流前は`record: null`）。
  app.get("/api/projects/:projectId/outcomes/:outcomeId/execution-summary", async (c) =>
    c.json({
      record: await human.getExecutionSummary.execute(
        await actorOf(c),
        c.req.param("projectId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  app.get("/api/projects/:projectId/outcomes/:outcomeId/evaluations", async (c) =>
    c.json({
      evaluations: await human.listOutcomeEvaluations.execute(
        await actorOf(c),
        c.req.param("projectId"),
        c.req.param("outcomeId"),
      ),
    }),
  );
  // Execution閲覧（Task 45。docs/lv6-unification-design.md「Web UIの配置と移行順」U2）。GETだけで、Execution serviceの
  // Grant不要な読取へMembership（viewer以上）の認可後に委譲する。MCP・SQLite tableをWeb UIから直接使わない。
  app.get("/api/projects/:projectId/execution", async (c) => {
    const actor = await actorOf(c);
    const outcomeId = c.req.query("outcomeId");
    return c.json(await human.listExecution.execute(actor, c.req.param("projectId"), outcomeId === undefined ? {} : { outcomeId }));
  });
  app.get("/api/projects/:projectId/tasks/:taskId", async (c) =>
    c.json(await human.getExecutionTask.execute(await actorOf(c), c.req.param("projectId"), c.req.param("taskId"))),
  );
  app.get("/api/projects/:projectId/changes", async (c) =>
    c.json(
      await human.listRecentExecutionChanges.execute(await actorOf(c), c.req.param("projectId"), {
        beforeCursor: queryNumber(c.req.query("beforeCursor")),
        limit: queryNumber(c.req.query("limit")),
      }),
    ),
  );
  // Execution介入（Task 46。U3）。Membershipのeditor以上＝`execution.intervene`。操作者はSessionのHumanから導出し、本文では受け取らない。
  const taskPath = "/api/projects/:projectId/tasks/:taskId";
  app.post(`${taskPath}/accept`, async (c) =>
    c.json(await human.acceptExecutionTask.execute(await actorOf(c), c.req.param("projectId"), c.req.param("taskId"))),
  );
  app.post(`${taskPath}/reject`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Task");
    return c.json(await human.rejectExecutionTask.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input));
  });
  app.post(`${taskPath}/cancel`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Task");
    return c.json(await human.cancelExecutionTask.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input));
  });
  app.post(`${taskPath}/comments`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Comment");
    return c.json(await human.addExecutionTaskComment.execute(actor, c.req.param("projectId"), c.req.param("taskId"), input), 201);
  });
  // Human Membershipと招待（docs/step-6-human-auth-design.md）。認可はMembershipのuse caseが権限表で行う。
  const membersPath = "/api/projects/:projectId/members";
  app.get(membersPath, async (c) =>
    c.json({ members: await services.listProjectMembersUseCase.execute(await actorOf(c), c.req.param("projectId")) }),
  );
  app.patch(`${membersPath}/:membershipId`, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Membership");
    const membership = await services.changeProjectMemberRoleUseCase.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("membershipId"),
      input,
    );
    return c.json({ membership });
  });
  app.delete(`${membersPath}/:membershipId`, async (c) => {
    const actor = await actorOf(c);
    const membership = await services.revokeProjectMemberUseCase.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("membershipId"),
    );
    return c.json({ membership });
  });
  const invitationsPath = "/api/projects/:projectId/invitations";
  app.get(invitationsPath, async (c) =>
    c.json({
      invitations: await services.listProjectInvitationsUseCase.execute(await actorOf(c), c.req.param("projectId")),
    }),
  );
  // tokenの平文は発行応答で一度だけ返す。リンクはURL fragmentで渡し、access logへ残さない。
  app.post(invitationsPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Invitation");
    const { invitation, token } = await services.createProjectInvitationUseCase.execute(
      actor,
      c.req.param("projectId"),
      input,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ invitation, invitationUrl: `${humanAuth.publicOrigin}/invite#${token}` }, 201);
  });
  app.delete(`${invitationsPath}/:invitationId`, async (c) => {
    const actor = await actorOf(c);
    const invitation = await services.revokeProjectInvitationUseCase.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("invitationId"),
    );
    return c.json({ invitation });
  });
  // Agent / Runtime Credential（Task 37）。Administrator以上。secretは発行・rotationの応答で一度だけ返す。
  const credentialsPath = "/api/projects/:projectId/credentials";
  app.get(credentialsPath, async (c) =>
    c.json({
      credentials: await services.listAccessCredentialsUseCase.execute(await actorOf(c), c.req.param("projectId")),
    }),
  );
  app.post(credentialsPath, async (c) => {
    const actor = await actorOf(c);
    const input = await readJsonBody(c.req.raw, "Credential");
    const issued = await services.issueAccessCredentialUseCase.execute(actor, c.req.param("projectId"), input);
    c.header("Cache-Control", "no-store");
    return c.json(issued, 201);
  });
  app.post(`${credentialsPath}/:credentialId/rotate`, async (c) => {
    const actor = await actorOf(c);
    const hasBody = (await c.req.raw.clone().text()).trim() !== "";
    const input = hasBody ? await readJsonBody(c.req.raw, "Credential") : {};
    const rotated = await services.rotateAccessCredentialUseCase.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("credentialId"),
      input,
    );
    c.header("Cache-Control", "no-store");
    return c.json(rotated, 201);
  });
  app.delete(`${credentialsPath}/:credentialId`, async (c) => {
    const actor = await actorOf(c);
    const credential = await services.revokeAccessCredentialUseCase.execute(
      actor,
      c.req.param("projectId"),
      c.req.param("credentialId"),
    );
    return c.json({ credential });
  });
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
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer(services, caller, { mode: humanAuth.mode });
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
    console.error(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal Server Error" } }, 500);
  });

  return app;
};
