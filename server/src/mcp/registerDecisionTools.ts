import { z } from "zod";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDirectionDecisionMcpSchema, decideNextOutcomeMcpSchema, adrHandoffRequestMcpSchema, adrReferenceMcpSchema } from "./toolInputSchemas.ts";

export const registerDecisionTools = (server: McpServer, context: McpRequestContext) => {
  const { services, asWorkspaceReader, asStrategistWithPrincipal } = context;

  server.registerTool(
    "create_direction_decision",
    {
      title: "Create Direction Decision",
      description:
        "Record a Direction Decision for the active Intent as additional_research, intent_complete, intent_abandon, " +
        "policy_proposal or adr_candidate (for next_outcome use decide_next_outcome instead, which saves the Decision and " +
        "the Outcome atomically). judgment and reason record what was decided and why; options records alternatives considered; " +
        "usedSyntheses (Synthesis id + its current version) and usedFindingIds cite the evidence used, and must reference " +
        "Synthesis/Finding ids that exist in this Workspace (a stale or wrong version fails with CONFLICT). The Intent Brief at " +
        "decision time is snapshotted and stored with the Decision. policy_proposal only records a proposal; it never changes " +
        "the Workspace's Mission, Vision, Principles or Constraints directly (a Human changes them in the Web UI if a reviewed " +
        "change is later approved). additional_research requires research (question, scope, completionCondition, budgetTotal 1-10000, " +
        "optional future deadlineAt as epoch milliseconds; the Strategist decides these): Compass saves the Decision, an additional " +
        "Research Request (returned as researchRequest, correlationId decision:<decisionId>) and a research_requested Runtime event " +
        "in one transaction, and research is rejected for the other types. It does not start the Researcher; the Runtime does that " +
        "after fetching the event. evaluationId cites the Outcome Evaluation (from an outcome_evaluated event or " +
        "get_strategist_context's evaluations) the decision is based on: optional for additional_research, required for " +
        "intent_complete, rejected for the other types. It must be the latest Evaluation of an Outcome under this Intent " +
        "(a superseded one fails with CONFLICT reason evaluation_not_latest) and one Evaluation can back only one Decision " +
        "(CONFLICT reason evaluation_already_decided). intent_complete means the Intent's completionDefinition is judged " +
        "fulfilled - not merely that one Outcome was achieved or Execution finished: it requires an achieved Evaluation " +
        "(CONFLICT reason evaluation_result_mismatch otherwise) and an Intent with a completionDefinition (CONFLICT reason " +
        "no_completion_definition), and it moves the Intent to achieved in the same transaction. If the Outcome was achieved " +
        "but the Intent is not complete yet, use decide_next_outcome with that evaluationId instead. " +
        "requestKey makes a resend idempotent (it returns the same decision and researchRequest); the same requestKey with different content fails with " +
        "CONFLICT. Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: createDirectionDecisionMcpSchema,
    },
    ({ workspaceId, ...input }) =>
      execute(() =>
        asStrategistWithPrincipal(workspaceId, async (principalId) =>
          services.createDirectionDecisionUseCase.execute(workspaceId, principalId, input),
        ),
      ),
  );
  server.registerTool(
    "decide_next_outcome",
    {
      title: "Decide Next Outcome",
      description:
        "Record a next_outcome Direction Decision and its Outcome (with fixed Success Criteria, 1-10 items, same rules as " +
        "create_outcome) in one atomic operation: neither is saved without the other. Use this instead of create_outcome when the " +
        "choice should carry a recorded rationale and evidence trail (judgment, reason, options considered, usedSyntheses id+version, " +
        "usedFindingIds, and a snapshot of the Intent Brief at decision time). create_outcome remains available for creating an " +
        "Outcome without a Decision record; those Outcomes keep originDecisionId null and continue to work as before. " +
        "evaluationId optionally cites the Outcome Evaluation this re-plan is based on (after a failed or insufficient_evidence " +
        "Evaluation, or an achieved one when the Intent still needs another Outcome); it must be the latest Evaluation of an Outcome " +
        "under this Intent and not yet used by another Decision (CONFLICT otherwise). requestKey " +
        "makes a resend idempotent; the same requestKey with different content fails with CONFLICT. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: decideNextOutcomeMcpSchema,
    },
    ({ workspaceId, ...input }) =>
      execute(() =>
        asStrategistWithPrincipal(
          workspaceId,
          async (principalId) => await services.decideNextOutcomeUseCase.execute(workspaceId, principalId, input),
        ),
      ),
  );

  server.registerTool(
    "create_adr_handoff_request",
    {
      title: "Create ADR Handoff Request",
      description:
        "Build and persist the fixture payload Compass would hand off to Wacha's existing Manager/Worker/Reviewer to " +
        "reflect an adr_candidate Direction Decision as a Repository ADR (no new Wacha Execution Role is introduced). " +
        "decisionId must reference an adr_candidate Decision in this Workspace (CONFLICT otherwise); projectId names the target " +
        "Project, which must belong to the Workspace, and repositoryId must reference a Repository already registered on that " +
        "Project (NOT_FOUND otherwise). The payload (decisionId, " +
        "intentId, usedSyntheses id+version, usedFindingIds, the Repository's name/url, the Workspace's current " +
        "Constraints, and expectedAdrContent derived deterministically from the Decision's judgment/reason/options — " +
        "Compass decides the content, Wacha only reflects it) is snapshotted at creation time and does not change on " +
        "replay. requestKey makes a resend idempotent; the same requestKey with different content fails with CONFLICT. " +
        "correlationId threads this request to the completion result recorded later with record_adr_reference. This " +
        "does not call Wacha or any external system (real Wacha integration is not connected yet). " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: adrHandoffRequestMcpSchema,
    },
    ({ workspaceId, ...input }) =>
      execute(() =>
        asStrategistWithPrincipal(workspaceId, async (principalId) => ({
          request: await services.createAdrHandoffRequestUseCase.execute(workspaceId, principalId, input),
        })),
      ),
  );
  server.registerTool(
    "record_adr_reference",
    {
      title: "Record ADR Reference",
      description:
        "Ingest the completion result Wacha's Manager/Worker/Reviewer produced for an adr_candidate Decision and store " +
        "it as a Workspace-owned reference to the target Project's artifact: the Repository, a relative path inside it (never treated as a server " +
        "filesystem path; a leading slash, a Windows drive letter or any .. segment is rejected with VALIDATION_ERROR), " +
        "a full 40-character commit SHA (abbreviated or non-hex values are rejected), and an optional http(s) pull " +
        "request URL. A matching create_adr_handoff_request (same decisionId, repositoryId and correlationId) must " +
        "already exist, or this fails with CONFLICT. requestKey makes a resend idempotent; the same requestKey with " +
        "different content fails with CONFLICT. This does not write to the Repository's working tree or call any " +
        "external system; it only records the reference Wacha reported. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: adrReferenceMcpSchema,
    },
    ({ workspaceId, ...input }) =>
      execute(() =>
        asStrategistWithPrincipal(workspaceId, async (principalId) => ({
          reference: await services.recordAdrReferenceUseCase.execute(workspaceId, principalId, input),
        })),
      ),
  );
  server.registerTool(
    "list_adr_references",
    {
      title: "List ADR References",
      description:
        "List the ADR references recorded in a Workspace, newest first: the target Project and Repository, path, commit SHA, " +
        "pull request URL and the Direction Decision each one traces back to.",
      inputSchema: { workspaceId: z.string().min(1) },
    },
    ({ workspaceId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, async () => ({ references: await services.listAdrReferencesUseCase.execute(workspaceId) })),
      ),
  );
};
