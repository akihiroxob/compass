import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activityEntityKinds, maximumActivityPageSize } from "@compass/activity";
import { agentPrincipalOf, type Caller } from "@compass/access";
import type { OperationServices } from "../bootstrap/createApplicationServices.ts";
import { execute } from "./toolExecution.ts";

const refsDescription =
  "refs point to where things are instead of copying them: " +
  "{kind:'project_resource', resourceId, path?, revision?}, {kind:'url', url}, " +
  `or {kind:${activityEntityKinds.map((kind) => `'${kind}'`).join("|")}, id}. Do not copy Repository / Docs content into body. `;

const listDescription =
  "as summaries with refs (no body; hasBody tells whether the get tool has more). Without " +
  "afterCursor the newest come first and nextCursor is the beforeCursor of the next (older) page; with afterCursor they come " +
  "in ascending order and nextCursor is the next afterCursor. Filter by principalId, role, type, or a referenced entity " +
  "(refKind + refId). Activity is history for understanding context, not a workflow checkpoint: decide what to do from the " +
  "current Direction / Work state. ";

const listQuerySchema = {
  afterCursor: z.number().int().min(0).optional(),
  beforeCursor: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(maximumActivityPageSize).optional(),
  principalId: z.string().optional(),
  role: z.string().optional(),
  type: z.string().optional(),
  refKind: z.enum([...activityEntityKinds, "project_resource"]).optional(),
  refId: z.string().optional(),
};

const recordInputFields = {
  type: z.string().describe("Dot-separated lowercase words, e.g. research.summary or decision.recorded"),
  summary: z.string(),
  body: z.string().nullable().optional(),
  refs: z.array(z.record(z.string(), z.unknown())).optional(),
  role: z.string().optional(),
  correctsActivityId: z.string().optional(),
  occurredAt: z.number().int().optional(),
  requestId: z.string().min(1).describe("Caller-generated idempotency key"),
};

/**
 * Activity（Project・Workspaceの意味のある履歴）のtool。入力規則・認可・冪等性はActivityのuse caseが持ち、ここはPrincipalを渡すだけ。
 * Project ActivityはProject Role Grant、Workspace ActivityはWorkspace Role Grantで認可し、互いのscopeを返さない。
 * PrincipalはBearerから解決し、tool入力からは受け取らない。Runtime Credentialは対象外（UNAUTHENTICATED）。
 */
export const registerActivityTools = (server: McpServer, services: OperationServices, caller: Caller) => {
  const principal = agentPrincipalOf(caller);

  server.registerTool(
    "record_activity",
    {
      title: "Record Activity",
      description:
        "Record a meaningful Activity of a Project so that Humans and Agents can later understand what happened, what was learned " +
        "and what was decided (research result, decision rationale, handoff, deliverable). summary is required and is what others " +
        "read first; body is optional Markdown. " + refsDescription +
        "project_resource.resourceId is a repository / resource id registered in this Project. " +
        "Activities are append-only: to correct one, record a new Activity with correctsActivityId. Unknown fields such as runId " +
        "or deliverable content are rejected with VALIDATION_ERROR. Task / Story state changes and Project archive are recorded automatically; do not duplicate them. " +
        "Workspace Direction history (research, decisions, evaluation) belongs to record_workspace_activity. " +
        "The Principal comes from Authorization; role must be a Role you hold in the Project (defaults to X-Compass-Active-Role). " +
        "The same requestId returns the same Activity; reusing it with different content fails with CONFLICT.",
      // 未知の項目（runId・成果物本文の取り違え等）をMCP境界で黙って捨てず、use caseの厳格な検査でVALIDATION_ERRORにする。
      inputSchema: z.looseObject({ projectId: z.string().min(1), ...recordInputFields }),
    },
    (input) => execute(() => services.recordActivityUseCase.execute(principal, input)),
  );
  server.registerTool(
    "list_activities",
    {
      title: "List Activities",
      description:
        "List Activities of a Project " + listDescription +
        "Workspace Activities (Direction history) are not included; use list_workspace_activities. " +
        "Requires any Role Grant in the Project (the active role's Grant with X-Compass-Active-Role).",
      inputSchema: { projectId: z.string().min(1), ...listQuerySchema },
    },
    ({ projectId, ...query }) => execute(() => services.agentActivityReader.listActivities(principal, projectId, query)),
  );
  server.registerTool(
    "get_activity",
    {
      title: "Get Activity",
      description:
        "Get one Activity with its body and refs, and the Activities that correct it (corrections, oldest first). Read referenced " +
        "deliverables from their Repository / Docs. Requires any Role Grant in the Project (the active role's Grant with X-Compass-Active-Role).",
      inputSchema: { projectId: z.string().min(1), activityId: z.string().min(1) },
    },
    ({ projectId, activityId }) => execute(() => services.agentActivityReader.getActivity(principal, projectId, activityId)),
  );

  server.registerTool(
    "record_workspace_activity",
    {
      title: "Record Workspace Activity",
      description:
        "Record a meaningful Activity of a Workspace (research findings, direction rationale, evaluation notes, handoff) so that " +
        "Humans and Agents can later understand what happened, what was learned and what was decided at the strategy level. " +
        "summary is required; body is optional Markdown. " + refsDescription +
        "project_resource.resourceId is a repository / resource id registered in a Project of this Workspace. " +
        "Activities are append-only: to correct one, record a new Workspace Activity with correctsActivityId. Unknown fields such as runId " +
        "or deliverable content are rejected with VALIDATION_ERROR. Intent, Outcome, Research Request, Direction Decision and Evaluation " +
        "state changes are recorded automatically; do not duplicate them. Project Work history belongs to record_activity. " +
        "The Principal comes from Authorization; role must be a Workspace Role you hold in the Workspace (strategist, researcher, " +
        "evaluator; defaults to X-Compass-Active-Role). Project Role Grants do not apply. The same requestId returns the same " +
        "Activity; reusing it with different content fails with CONFLICT. An archived Workspace fails with CONFLICT.",
      inputSchema: z.looseObject({ workspaceId: z.string().min(1), ...recordInputFields }),
    },
    (input) => execute(() => services.recordWorkspaceActivityUseCase.execute(principal, input)),
  );
  server.registerTool(
    "list_workspace_activities",
    {
      title: "List Workspace Activities",
      description:
        "List Activities of a Workspace " + listDescription +
        "Activities of the Workspace's Projects are not included; use list_activities with a Project Grant. " +
        "Requires any Workspace Role Grant in the Workspace (the active role's Grant with X-Compass-Active-Role).",
      inputSchema: { workspaceId: z.string().min(1), ...listQuerySchema },
    },
    ({ workspaceId, ...query }) => execute(() => services.agentWorkspaceActivityReader.listActivities(principal, workspaceId, query)),
  );
  server.registerTool(
    "get_workspace_activity",
    {
      title: "Get Workspace Activity",
      description:
        "Get one Workspace Activity with its body and refs, and the Activities that correct it (corrections, oldest first). " +
        "Read referenced deliverables from their Repository / Docs. Requires any Workspace Role Grant in the Workspace " +
        "(the active role's Grant with X-Compass-Active-Role).",
      inputSchema: { workspaceId: z.string().min(1), activityId: z.string().min(1) },
    },
    ({ workspaceId, activityId }) => execute(() => services.agentWorkspaceActivityReader.getActivity(principal, workspaceId, activityId)),
  );
};
