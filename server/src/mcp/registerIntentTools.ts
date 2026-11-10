import { z } from "zod";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { intentCreateSchema, intentUpdateSchema, intentFieldsDescription } from "./toolInputSchemas.ts";

export const registerIntentTools = (server: McpServer, context: McpRequestContext) => {
  const { services, remote, principal, asWorkspaceReader, asWorkspaceOperator, asIntentAuthor } = context;

  // Intentの登録・更新は、外部MCPクライアントでHumanと整理した目標をStrategistが登録する正規の入口。Web UIと同じuse caseへ委譲する。
  server.registerTool(
    "create_intent",
    {
      title: "Create Intent",
      description:
        "Create an active Intent (business goal) in a Workspace. " + intentFieldsDescription + " " +
        "A Workspace can have multiple active Intents; creating one does not abandon or modify the others. " +
        "Creating an Intent does not start Strategist or Research. An archived Workspace fails with CONFLICT (workspaceStatus archived). " +
        "Requires Authorization: Bearer <AgentName> with a Strategist Grant of the Workspace (with X-Compass-Active-Role it must be " +
        "strategist; Project Grants do not count); UNAUTHENTICATED / FORBIDDEN otherwise. The Activity records the Strategist as the actor.",
      inputSchema: intentCreateSchema,
    },
    ({ workspaceId, ...input }) =>
      execute(() => asIntentAuthor(workspaceId, () => services.createIntentUseCase.execute(workspaceId, input))),
  );
  server.registerTool(
    "list_intents",
    {
      title: "List Intents",
      description: "List the Intents of a Workspace, newest first.",
      inputSchema: { workspaceId: z.string().min(1) },
    },
    ({ workspaceId }) =>
      execute(() => asWorkspaceReader(workspaceId, async () => ({ intents: await services.listIntentsUseCase.execute(workspaceId) }))),
  );
  server.registerTool(
    "get_intent",
    {
      title: "Get Intent",
      description: "Get an Intent by ID within a Workspace. An Intent of another Workspace fails with NOT_FOUND.",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ workspaceId, intentId }) =>
      execute(() => asWorkspaceReader(workspaceId, () => services.getIntentUseCase.execute(workspaceId, intentId))),
  );
  server.registerTool(
    "update_intent",
    {
      title: "Update Intent",
      description:
        "Update fields of an active Intent. " + intentFieldsDescription + " Omitted fields are unchanged; " +
        "null or an empty string clears an optional field. Abandoned or achieved Intents cannot be edited (CONFLICT). " +
        "expectedVersion (required) is the Intent version your edit or judgment is based on (Intent.version from get_intent). " +
        "If the Intent was saved after that, nothing is changed and CONFLICT (conflict intent_version, currentVersion) is returned: " +
        "read the current Intent and review it before retrying; never treat evidence from an older version as the current one. " +
        "Every save creates a new version with the actor and reason (list_intent_revisions). When the Intent already has Outcomes, " +
        "changing desiredState or completionDefinition requires a reason; it is not forbidden. Existing Outcomes, Evaluations and " +
        "Decisions keep the version they were based on, and unfinished Outcomes based on an older meaning become re-plan targets " +
        "(orchestration state intentRevised). Requires a Strategist Grant of the Workspace, the same as create_intent.",
      inputSchema: intentUpdateSchema,
    },
    ({ workspaceId, intentId, ...input }) =>
      execute(() =>
        asIntentAuthor(workspaceId, () => services.updateIntentUseCase.execute(workspaceId, intentId, input)),
      ),
  );
  server.registerTool(
    "list_intent_revisions",
    {
      title: "List Intent Revisions",
      description:
        "List the saved versions of an Intent, newest first: the content of each version, whether the meaning changed, the reason " +
        "and who changed it. Outcomes, Evaluations and Decisions refer to the version they were based on with intentVersion.",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ workspaceId, intentId }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, async () => ({
          revisions: await services.listIntentRevisionsUseCase.execute(workspaceId, intentId),
        })),
      ),
  );
  // Intentの観測項目と時系列。入力規則はdirectionのintentMetricSchemaが持ち、ここでは型だけを宣言する。
  server.registerTool(
    "define_intent_metric",
    {
      title: "Define Intent Metric",
      description:
        "Define (or update by key) a Metric observed for an active Intent: key (1-64 of a-z, 0-9, _, -, . unique within the Intent), " +
        "name (up to 100), unit (up to 30, e.g. JPY, users, %), targetValue (an explicit finite number, or null when the goal has no " +
        "numeric target; never derive it from the Intent text) and staleAfterDays (1-366: the latest observation becomes stale when its " +
        "period ended more than this many days ago). The same definition again is unchanged (result: unchanged); a different one " +
        "increments revision (result: updated). The unit of a Metric with observations cannot change (CONFLICT, reason unit_locked). " +
        "This is not a separate Success Metrics hierarchy: Outcome Success Criteria stay as they are. An Intent of another Workspace " +
        "fails with NOT_FOUND; a non-active Intent (reason intent_not_active) or an archived Workspace fails with CONFLICT. " +
        "Requires Authorization: Bearer <AgentName> with a Strategist Grant of the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        key: z.string(),
        name: z.string(),
        unit: z.string(),
        targetValue: z.number().nullable().optional(),
        staleAfterDays: z.number(),
      },
    },
    ({ workspaceId, intentId, ...input }) =>
      execute(() => services.defineIntentMetricUseCase.execute(principal, workspaceId, intentId, input)),
  );
  server.registerTool(
    "list_intent_metrics",
    {
      title: "List Intent Metrics",
      description:
        "List the Metrics of an Intent (in definition order) with current = { state, latest, lastObserved } and series = { from, to, " +
        "points }. state is unmeasured (no observation), failed (the latest period's observation failed), stale (the latest value is " +
        "older than staleAfterDays) or observed (zero is a valid observed value). points are the latest revision of each observed " +
        "period overlapping from..to (YYYY-MM-DD, default: the 30 days up to today in UTC, at most 366 days), including failed ones " +
        "with value null; periods without an observation are absent and must not be filled with zero or estimates. No ratio or " +
        "progress is computed. An empty metrics list means no Metric is defined. An Intent of another Workspace fails with NOT_FOUND.",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    ({ workspaceId, intentId, from, to }) =>
      execute(() =>
        asWorkspaceReader(workspaceId, () =>
          services.listIntentMetricsUseCase.execute(workspaceId, intentId, {
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          }),
        ),
      ),
  );
  if (!remote) server.registerTool(
    "abandon_intent",
    {
      title: "Abandon Intent",
      description:
        "Abandon an active Intent with an optional reason (and an optional expectedVersion that must match the current version). " +
        "Its active Outcomes are cancelled, never marked achieved, and Tasks are not changed. Abandoned Intents cannot be reactivated; create a new Intent instead.",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        reason: z.string().nullable().optional(),
        expectedVersion: z.number().int().optional(),
      },
    },
    ({ workspaceId, intentId, reason, expectedVersion }) =>
      execute(() =>
        asWorkspaceOperator(workspaceId, () => services.abandonIntentUseCase.execute(workspaceId, intentId, { reason, expectedVersion })),
      ),
  );
  server.registerTool(
    "get_strategist_context",
    {
      title: "Get Strategist Context",
      description:
        "Get what a Strategist needs to decide the next Outcome: the Workspace (Mission, Vision, Principles, Constraints, status), " +
        "the selected Intent (specify intentId; omission is accepted only with at most one Active Intent), every Outcome under that Intent including cancelled ones, " +
        "projects (the Workspace's active Projects in creation order: id, name, description as the Project purpose, and " +
        "Repository / Resource references with name, url and kind; Resource content is not included), outcomeTargets (the current " +
        "Target Projects of those Outcomes, in Outcome order then set order, with projectStatus active | archived; use them with " +
        "projects to decide whether an Outcome needs Targets and which, then call set_outcome_target / unset_outcome_target), " +
        "and research (the Intent Brief: this Intent's Research Requests including cancelled ones, and the latest, " +
        "non-superseded Synthesis of each still-open request with its risks/options/unknowns, findingIds, validAsOf and a stale " +
        "flag when a cited Finding has expired; conflicts lists Finding id pairs that were declared to contradict each other, " +
        "never averaged or silently dropped; research is null when there is no active Intent). This does not include full Result " +
        "or Evidence text; use get_research_request with a requestId from research.requests to trace a Synthesis to its Findings " +
        "and Evidence references. evaluations lists the latest Outcome Evaluation of each Outcome under the active Intent " +
        "(result achieved | failed | insufficient_evidence, per-Criterion verdicts with rationale and evidenceIds, and a snapshot " +
        "of the Execution Summary and Evidence references at evaluation time), newest first; decisionId is the Direction Decision " +
        "already based on it, or null while it still awaits a re-plan or Intent completion decision. unavailable lists inputs that " +
        "are not implemented yet (evidence: Evidence content itself); do not assume or invent them. Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1).optional() },
    },
    ({ workspaceId, intentId }) => execute(() => services.getStrategistContextUseCase.execute(principal, workspaceId, intentId)),
  );
};
