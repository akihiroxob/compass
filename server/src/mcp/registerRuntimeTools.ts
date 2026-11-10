import { z } from "zod";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const registerRuntimeTools = (server: McpServer, context: McpRequestContext) => {
  const { services, caller, runtimeAuthorization } = context;

  server.registerTool(
    "fetch_runtime_events",
    {
      title: "Fetch Runtime Events",
      description:
        "For an external Runtime: fetch the Workspace's Runtime events that are still unprocessed for the calling consumer, " +
        "oldest first (research_requested starts a Researcher; research_completed starts a Strategist; outcome_confirmed starts a " +
        "Manager; outcome_evaluated, with evaluationId, starts a Strategist to re-plan or decide Intent completion). The consumer is the " +
        "Bearer Principal. Fetching does not change any state, so a lost response is recovered by fetching again; delivery is " +
        "at-least-once, so deduplicate by event id and acknowledge with ack_runtime_event. Pass nextCursor back as afterCursor " +
        "to page through the same pass. nextCursor may pass events that are still unacknowledged or in retryable_failure, so do not " +
        "persist it: to resume after a Runtime restart, persist resumeCursor (every event at or below it is processed or terminally " +
        "failed for this consumer) and pass it as afterCursor. Events in retryable_failure keep being returned with retryCount " +
        "and lastFailureReason; polling interval, backoff and Agent launching are the Runtime's responsibility. " +
        "Requires a Workspace Runtime Credential (Authorization: Bearer cmp_runtime...) of the Workspace with the runtime:event:read scope; " +
        "a Project Credential or a trusted-local Bearer <RuntimeName> is rejected (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        workspaceId: z.string().min(1),
        afterCursor: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    ({ workspaceId, ...query }) => execute(() => services.fetchRuntimeEventsUseCase.execute(caller, workspaceId, query)),
  );
  server.registerTool(
    "ack_runtime_event",
    {
      title: "Acknowledge Runtime Event",
      description:
        "For an external Runtime: record the result of handling one Runtime event for the calling consumer. " +
        "outcome processed: handled; the event is not returned to this consumer again. " +
        "retryable_failure (reason required): not handled this time; the event keeps being returned by fetch_runtime_events. " +
        "terminal_failure (reason required): cannot succeed; the event is not returned again and the reason is kept. " +
        "attemptId identifies one handling attempt of the event by this consumer: resending the same ack with the same attemptId after " +
        "a lost response returns the first result without changing state (recorded: false, retryCount is not incremented again); " +
        "reusing an attemptId of the event with a different outcome or reason fails with CONFLICT. Use a new attemptId for each new attempt. " +
        "Sending the same outcome again for an event already processed or terminally failed is idempotent (recorded: false); a different outcome for an event already " +
        "processed or terminally failed fails with CONFLICT. An event of another Workspace fails with NOT_FOUND. " +
        "Requires a Workspace Runtime Credential (Authorization: Bearer cmp_runtime...) of the Workspace with the runtime:event:ack scope; " +
        "a Project Credential or a trusted-local Bearer <RuntimeName> is rejected (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        workspaceId: z.string().min(1),
        eventId: z.string().min(1),
        attemptId: z.string().min(1),
        outcome: z.string(),
        reason: z.string().optional(),
      },
    },
    ({ workspaceId, ...input }) => execute(() => services.ackRuntimeEventUseCase.execute(caller, workspaceId, input)),
  );

  server.registerTool(
    "record_execution_evidence",
    {
      title: "Record Execution Evidence",
      description:
        "For an external Runtime: after reading the Execution changes (list_changes) up to changeCursor, reflect the Execution result of one " +
        "Outcome into Direction. The result (accepted / rejected / canceled / incomplete, per Story with Task counts) is derived by Compass " +
        "from the current Execution state, not from the Runtime's claim; evidence is a list of references " +
        "{ kind: commit | pull_request | repository_file | ci | issue | url, uri (http/https, no credentials), versionHash (full 40-character commit SHA, required for commit), " +
        "observedAt (epoch ms, not in the future) } - never Evidence content. Resending the same changes or evidence is idempotent " +
        "(recorded.evidenceAdded 0), a stale changeCursor (out-of-order delivery) never rolls the state back (recorded.staleInput true), " +
        "and a changeCursor ahead of the Execution change log is rejected with VALIDATION_ERROR. The Outcome belongs to the Project's Workspace " +
        "and the result is kept per Project (workspaceId and projectId); an Outcome of another Workspace fails with NOT_FOUND; " +
        "an Outcome without a correlated Story yet, a Project that is not a current Target Project of the Outcome (reason not_target_project), " +
        "a cancelled Outcome, an archived Project or more than 200 Evidence references from the Project fails with CONFLICT. " +
        "Accepted Execution does not mean a Success Criterion is met: that is decided by the Evaluation. " +
        "Requires a Runtime Credential (Authorization: Bearer cmp_runtime...) of the Project with the execution:evidence:write scope; in trusted-local mode " +
        "Bearer <RuntimeName> with a runtime Grant is also accepted (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        projectId: z.string().min(1),
        outcomeId: z.string().min(1),
        changeCursor: z.number(),
        evidence: z
          .array(
            z.object({
              kind: z.string(),
              uri: z.string(),
              versionHash: z.string().nullable().optional(),
              observedAt: z.number(),
            }),
          )
          .optional(),
      },
    },
    ({ projectId, outcomeId, ...input }) =>
      execute(() => services.recordExecutionEvidenceUseCase.execute(caller, projectId, outcomeId, input)),
  );
  server.registerTool(
    "get_outcome_execution_summary",
    {
      title: "Get Outcome Execution Summary",
      description:
        "Read the Execution result and Evidence references already reflected into an Outcome by record_execution_evidence " +
        "(record is null before the first reflection). It returns the state, the per-Story result with Task counts, the Execution change " +
        "cursor the state reflects (executionCursor), the highest cursor the Runtime reported (observedCursor) and the Evidence references " +
        "(uri, versionHash, observedAt, sourceChangeCursor). " +
        "Requires a Runtime Credential (Authorization: Bearer cmp_runtime...) of the Project with the execution:summary:read scope; in trusted-local mode " +
        "Bearer <RuntimeName> with a runtime Grant is also accepted (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: { projectId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ projectId, outcomeId }) =>
      execute(async () => {
        await runtimeAuthorization.requireScope(caller, projectId, "execution:summary:read");
        return { record: await services.getExecutionSummaryUseCase.execute(projectId, outcomeId) };
      }),
  );

  server.registerTool(
    "get_workspace_orchestration_state",
    {
      title: "Get Workspace Orchestration State",
      description:
        "For an external Orchestrator: read the Workspace's current state used to decide which specialist Role to start. " +
        "It returns the Workspace status, its active Projects (id and name; archived Projects are excluded), the active Intent " +
        "(id and status only), the active Intent's Outcomes with their Target Projects in configured order (projectStatus, the " +
        "Project's Work counts for the Outcome - null before the Project has a correlated Story - and the Execution summary the " +
        "Project already reflected - null while not reflected), the evaluability over all Targets (no_targets, awaiting_execution, " +
        "evaluable, or replan_required when an archived Target has an unreflected or incomplete Execution, with the unfinished " +
        "Targets), the latest Evaluation with the Direction Decision based on it (decisionId null while undecided) and the per-Project " +
        "Execution cursors it evaluated, the active Intent's Research Requests and the Workspace's open (requested / running) Research " +
        "Requests. Each active Intent carries version and meaningVersion, and each Outcome the intentVersion it is based on; " +
        "intentRevised is non-null for an active Outcome whose Intent meaning (desiredState / completionDefinition) changed after that " +
        "version, which marks it as an explicit re-plan target (work is not stopped). An archived Workspace returns only its status with empty lists. No content (Mission, Intent or Outcome text, " +
        "Research findings, Story / Task text) is included: the started Role reads it through its own Role Context. Reading does " +
        "not change state and does not depend on Activity or Runtime event cursors. Requires a Workspace Runtime Credential " +
        "(Authorization: Bearer cmp_runtime...) of the Workspace with the runtime:state:read scope; a Project Credential or a " +
        "trusted-local Bearer <RuntimeName> is rejected (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: { workspaceId: z.string().min(1) },
    },
    ({ workspaceId }) => execute(() => services.getWorkspaceOrchestrationStateUseCase.execute(caller, workspaceId)),
  );
};
