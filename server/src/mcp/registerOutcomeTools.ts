import { z } from "zod";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outcomeProblemsDescription, outcomeCreateSchema, outcomeUpdateSchema } from "./toolInputSchemas.ts";

export const registerOutcomeTools = (server: McpServer, context: McpRequestContext) => {
  const { services, asWorkspaceReader, asStrategist } = context;
  server.registerTool(
    "create_outcome",
    {
      title: "Create Outcome",
      description:
        "Register an Outcome (with its Success Criteria) under an active Intent as a Strategist decision. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise). " +
        "rationale records why this Outcome was chosen. Success Criteria are fixed at creation (1-10 items) and cannot be edited later; " +
        "to change them, cancel the Outcome and create a new one. Outcomes are never generated from an Intent automatically, " +
        "and Research is not required. Optional: " + outcomeProblemsDescription,
      inputSchema: outcomeCreateSchema,
    },
    ({ workspaceId, intentId, ...input }) =>
      execute(() =>
        asStrategist(workspaceId, async () => ({
          outcome: await services.createOutcomeUseCase.execute(workspaceId, intentId, input),
        })),
      ),
  );
  server.registerTool(
    "list_outcomes",
    {
      title: "List Outcomes",
      description: "List the Outcomes of an Intent with their Success Criteria, newest first.",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ workspaceId, intentId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, async () => ({
          outcomes: await services.listOutcomesUseCase.execute(workspaceId, intentId),
        })),
      ),
  );
  server.registerTool(
    "get_outcome",
    {
      title: "Get Outcome",
      description:
        "Get an Outcome by ID within a Workspace and Intent: Success Criteria, problems with evidence (kind, id, requestId, summary, " +
        "superseded) and revision (use it as expectedRevision of update_outcome).",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ workspaceId, intentId, outcomeId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, async () => ({
          outcome: await services.getOutcomeUseCase.execute(workspaceId, intentId, outcomeId),
        })),
      ),
  );
  server.registerTool(
    "update_outcome",
    {
      title: "Update Outcome",
      description:
        "Update title, hypothesis or problems of an active Outcome. Omitted fields are unchanged; null or an empty string clears hypothesis. " +
        "Pass intentVersion (the current Intent.version) to record that you reviewed the Outcome against the current Intent; this clears the " +
        "re-plan target (intentRevised) after the Intent meaning changed, and fails with CONFLICT if the Intent moved on again. " +
        "problems replaces the whole list (pass an existing problem id to keep it) and requires expectedRevision, the revision you read " +
        "with get_outcome; if the Outcome was updated since then the call fails with CONFLICT (currentRevision). Every update increments revision. " +
        outcomeProblemsDescription + " " +
        "description, rationale and successCriteria are fixed at creation and are rejected with CONFLICT; Target Projects are not changed. " +
        "Cancelled Outcomes cannot be edited. Requires a strategist Grant in the Workspace.",
      inputSchema: outcomeUpdateSchema,
    },
    ({ workspaceId, intentId, outcomeId, ...input }) =>
      execute(() =>
        asStrategist(workspaceId, async () => ({
          outcome: await services.updateOutcomeUseCase.execute(workspaceId, intentId, outcomeId, input),
        })),
      ),
  );
  server.registerTool(
    "cancel_outcome",
    {
      title: "Cancel Outcome",
      description:
        "Cancel an active Outcome with a required reason. Cancelled Outcomes keep their Success Criteria and cannot be reactivated.",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        outcomeId: z.string().min(1),
        reason: z.string(),
      },
    },
    ({ workspaceId, intentId, outcomeId, reason }) =>
      execute(() =>
        asStrategist(workspaceId, async () => ({
          outcome: await services.cancelOutcomeUseCase.execute(workspaceId, intentId, outcomeId, { reason }),
        })),
      ),
  );
  const outcomeTargetInput = {
    workspaceId: z.string().min(1),
    outcomeId: z.string().min(1),
    projectId: z.string().min(1),
  };
  server.registerTool(
    "set_outcome_target",
    {
      title: "Set Outcome Target Project",
      description:
        "Set a Project of the same Workspace as a Target Project of an active Outcome (the Project's manager then plans Stories " +
        "for the Outcome). Choosing Target Projects is the Strategist's decision; an Outcome may have none. " +
        "A Project of another Workspace is NOT_FOUND; an archived Project, a Project that is already a Target, " +
        "or an Outcome that is not active fails with CONFLICT. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: outcomeTargetInput,
    },
    ({ workspaceId, outcomeId, projectId }) =>
      execute(() =>
        asStrategist(workspaceId, async () => ({
          target: await services.setOutcomeTargetProjectUseCase.execute(workspaceId, outcomeId, projectId),
        })),
      ),
  );
  server.registerTool(
    "unset_outcome_target",
    {
      title: "Unset Outcome Target Project",
      description:
        "Remove a Target Project from an active Outcome, including an archived Project. Existing Stories, execution results and " +
        "Evidence references are kept. After a Target Project is archived, decide whether to remove it and set an active Project " +
        "of the same Workspace instead, or to revise the Outcome. NOT_FOUND if the Project is not a Target; CONFLICT if the Outcome " +
        "is not active. Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: outcomeTargetInput,
    },
    ({ workspaceId, outcomeId, projectId }) =>
      execute(() =>
        asStrategist(workspaceId, async () => ({
          target: await services.unsetOutcomeTargetProjectUseCase.execute(workspaceId, outcomeId, projectId),
        })),
      ),
  );
  server.registerTool(
    "list_outcome_targets",
    {
      title: "List Outcome Target Projects",
      description:
        "List the Target Projects of an Outcome in the order they were set, each with the Project's current status " +
        "(active | archived). An Outcome without Target Projects returns an empty list.",
      inputSchema: { workspaceId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ workspaceId, outcomeId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, async () => ({
          targets: await services.listOutcomeTargetProjectsUseCase.execute(workspaceId, outcomeId),
        })),
      ),
  );
  server.registerTool(
    "list_outcome_target_executions",
    {
      title: "List Outcome Target Executions",
      description:
        "Read the Execution results reflected into an Outcome, per Target Project: targets lists the Target Projects in the order " +
        "they were set, each with the Project's current status and execution = { summary, evidence } reflected from that Project by " +
        "record_execution_evidence (null until the Project's first reflection). Summaries and Evidence references are kept per Project " +
        "and never merged; a Target's accepted state does not mean the Outcome is achieved. nonTargetExecutions lists records reflected " +
        "before their Project was removed from the Targets and do not count for evaluability. evaluability = { status, " +
        "unfinishedTargets } tells whether the Outcome can be evaluated: evaluable (every Target reflected and none incomplete), " +
        "no_targets (the Strategist decides the Target Projects), replan_required (an archived Target still has no reflected Summary " +
        "or an incomplete one; the Strategist replans) or awaiting_execution (an active Target has not finished). An archived Target " +
        "whose finished Execution was reflected before the archive stays an evaluation input. Evidence content and Story / Task " +
        "contents are not included.",
      inputSchema: { workspaceId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ workspaceId, outcomeId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, () => services.listOutcomeTargetExecutionsUseCase.execute(workspaceId, outcomeId)),
      ),
  );
  server.registerTool(
    "list_outcome_target_work",
    {
      title: "List Outcome Target Work",
      description:
        "For every Outcome of an Intent (newest first), list its Target Projects in the order they were set, each with the " +
        "Project's current status and a summary of the Project's Work correlated to the Outcome: work is null when the Project " +
        "has no Story for the Outcome yet, otherwise { state: accepted | rejected | canceled | incomplete, storyCount, taskCounts } " +
        "counted from that Project's Stories only. An Outcome with an empty targets list has no Target Projects. " +
        "Story and Task contents are not included; read them from the Project.",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ workspaceId, intentId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, async () => ({
          outcomes: await services.listOutcomeTargetWorkUseCase.execute(workspaceId, intentId),
        })),
      ),
  );
};
