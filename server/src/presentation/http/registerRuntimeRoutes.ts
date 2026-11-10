import type { Hono } from "hono";
import type { HttpRequestContext } from "./httpRequestContext.ts";
import { queryNumber } from "./httpQuery.ts";

export const registerRuntimeRoutes = (app: Hono, context: HttpRequestContext) => {
  const { callerOf, operationServicesOf, readJsonBody } = context;
  // 外部Runtime向け。Runtime eventはWorkspace所有で、consumerはWorkspace Runtime Credentialの名前。発行Workspaceのイベントだけを扱う。
  // Project Credential・trusted-localのAgent名では認可しない。Session Cookieでも認可しない（Human Membershipと混同しない）。
  // 認可・cursor・ackの規則は、MCPと同じapplication層のuse caseが持つ。
  app.get("/api/workspaces/:workspaceId/runtime-events", async (c) =>
    c.json(
      await operationServicesOf(c).fetchRuntimeEventsUseCase.execute(
        await callerOf(c),
        c.req.param("workspaceId"),
        { afterCursor: queryNumber(c.req.query("afterCursor")), limit: queryNumber(c.req.query("limit")) },
      ),
    ),
  );
  app.post("/api/workspaces/:workspaceId/runtime-events/:eventId/ack", async (c) => {
    const caller = await callerOf(c);
    const input = await readJsonBody(c.req.raw, "Runtime event ack");
    const result = await operationServicesOf(c).ackRuntimeEventUseCase.execute(caller, c.req.param("workspaceId"), {
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
      await operationServicesOf(c).recordExecutionEvidenceUseCase.execute(
        caller,
        c.req.param("projectId"),
        c.req.param("outcomeId"),
        input,
      ),
    );
  });
  // 公開確認の記録（Runtime）。CD・デプロイ通知・稼働確認が、公開先で確認したrevisionと根拠の参照を送る。方式によらず同じ契約。
  // Project Runtime Credentialの`publication:write`で認可し、Session Cookieでは受け付けない。規則はMCPと同じuse caseが持つ。
  app.post("/api/projects/:projectId/publications", async (c) => {
    const caller = await callerOf(c);
    const input = await readJsonBody(c.req.raw, "Publication");
    const result = await operationServicesOf(c).recordPublicationUseCase.execute(caller, c.req.param("projectId"), input);
    return c.json(result, result.recorded ? 201 : 200);
  });
};
