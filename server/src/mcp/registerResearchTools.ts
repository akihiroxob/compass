import { z } from "zod";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { researchRequestRef, researchResultSchema, researchSynthesisSchema } from "./toolInputSchemas.ts";

export const registerResearchTools = (server: McpServer, context: McpRequestContext) => {
  const { services, principal, asStrategist, asResearcher } = context;
  server.registerTool(
    "get_research_request",
    {
      title: "Get Research Request",
      description:
        "Get one Research Request by id with its full history: all registered Results (with Evidence references and Findings), " +
        "and all Synthesis versions (including ones superseded by a later version). Use this to trace a Synthesis id or Finding id " +
        "from get_strategist_context's research.syntheses / research.conflicts back to its Findings and cited Evidence. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchRequestRef,
    },
    ({ workspaceId, requestId }) =>
      execute(() =>
        asStrategist(workspaceId, () => services.getResearchRequestUseCase.execute(workspaceId, requestId)),
      ),
  );

  server.registerTool(
    "get_researcher_context",
    {
      title: "Get Researcher Context",
      description:
        "Get what a Researcher needs to work on one Research Request: the Workspace snapshot (Mission, Vision, Principles, Constraints, " +
        "status), the request (question, scope, completionCondition, status, deadline), the origin Intent (null for project_watch), " +
        "the remaining budget, results and syntheses already registered for this request, and related Findings with their Evidence references " +
        "from other requests of the same origin (newest first, capped). unavailable lists inputs that are not implemented yet; do not assume them. " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchRequestRef,
    },
    ({ workspaceId, requestId }) =>
      execute(() => services.getResearcherContextUseCase.execute(principal, workspaceId, requestId)),
  );
  server.registerTool(
    "list_research_requests",
    {
      title: "List Research Requests",
      description:
        "List the Research Requests of a Workspace, newest first, optionally filtered by originIntentId or status " +
        "(requested, running, completed, insufficient, not_needed, cancelled). " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        workspaceId: z.string().min(1),
        originIntentId: z.string().optional(),
        status: z.string().optional(),
      },
    },
    ({ workspaceId, ...filter }) =>
      execute(() =>
        asResearcher(workspaceId, async () => ({
          requests: await services.listResearchRequestsUseCase.execute(workspaceId, filter),
        })),
      ),
  );
  server.registerTool(
    "register_research_result",
    {
      title: "Register Research Result",
      description:
        "Append a Research Result (summary, Evidence references, Findings, unknowns, options, risks) to an open Research Request. " +
        "Every Finding must cite at least one of the Result's evidenceRefs by index. requestKey makes a resend idempotent; " +
        "the same requestKey with different content fails with CONFLICT. runRef identifies the Run; the Principal is taken from the Bearer. " +
        "Fails with CONFLICT for a closed request, a passed deadline or an exceeded budget (close it as insufficient instead). " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchResultSchema,
    },
    ({ workspaceId, requestId, ...input }) =>
      execute(() =>
        asResearcher(workspaceId, async (principalId) => ({
          result: await services.registerResearchResultUseCase.execute(workspaceId, requestId, { ...input, principalId }),
        })),
      ),
  );
  server.registerTool(
    "register_research_synthesis",
    {
      title: "Register Research Synthesis",
      description:
        "Append a Research Synthesis that compresses registered Findings (by findingIds) into a conclusion with validAsOf. " +
        "Set supersedesId to the latest version to add the next version; earlier versions are never overwritten. " +
        "requestKey makes a resend idempotent; runRef identifies the Run; the Principal is taken from the Bearer. " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchSynthesisSchema,
    },
    ({ workspaceId, requestId, ...input }) =>
      execute(() =>
        asResearcher(workspaceId, async (principalId) => ({
          synthesis: await services.registerResearchSynthesisUseCase.execute(workspaceId, requestId, {
            ...input,
            principalId,
          }),
        })),
      ),
  );
  server.registerTool(
    "complete_research_request",
    {
      title: "Complete Research Request",
      description:
        "Close a Research Request as completed, insufficient or not_needed. completed requires at least one registered Result and Synthesis; " +
        "insufficient and not_needed require stopReason. A closed request cannot be changed. Cancelling is not available to a Researcher. " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        ...researchRequestRef,
        conclusion: z.string(),
        stopReason: z.string().nullable().optional(),
      },
    },
    ({ workspaceId, requestId, ...input }) =>
      execute(() =>
        asResearcher(workspaceId, async () => ({
          request: await services.completeResearchRequestUseCase.execute(workspaceId, requestId, input),
        })),
      ),
  );
};
