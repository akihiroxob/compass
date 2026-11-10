import { z } from "zod";
import { ProjectRole } from "@compass/access";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outcomeEvaluationSchema } from "./toolInputSchemas.ts";

export const registerEvaluationTools = (server: McpServer, context: McpRequestContext) => {
  const { services, principal, asWorkspaceReader, asActorOf } = context;

  server.registerTool(
    "get_evaluator_context",
    {
      title: "Get Evaluator Context",
      description:
        "Get what an Evaluator needs to evaluate one Outcome: the Workspace snapshot, the origin Intent, the Outcome with its fixed " +
        "Success Criteria (id, position, description, measurement, target), targets (every Target Project in the order it was set, " +
        "with projectStatus and execution = { summary, evidence } reflected from that Project by record_execution_evidence, null until " +
        "its first reflection; Summaries and Evidence stay per Project), evaluability (status evaluable | no_targets | " +
        "replan_required | awaiting_execution with unfinishedTargets; an Evaluation can be recorded only when evaluable, i.e. every " +
        "Target reflected and none incomplete) and evaluations (this Outcome's earlier Evaluations, newest first). " +
        "It never includes Evidence content: observe the referenced sources yourself. unavailable lists inputs that are not " +
        "available; do not assume or invent them. Requires Authorization: Bearer <AgentName> with an evaluator Grant in the " +
        "Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: { workspaceId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ workspaceId, outcomeId }) =>
      execute(() => services.getEvaluatorContextUseCase.execute(principal, workspaceId, outcomeId)),
  );
  server.registerTool(
    "record_outcome_evaluation",
    {
      title: "Record Outcome Evaluation",
      description:
        "Save an Evaluation of an active Outcome. method (cognitive_walkthrough | quantitative_observation | ab_test | difference_in_differences | other), " +
        "targetVersion (the commit SHA or release evaluated) and limitations (sample, period, method constraints) are required; problemIds optionally names the " +
        "Outcome's problems[].id it evaluates, and planIds maps each such problem id to the evaluationPlan.planId you read (required for a problem that has a plan; a plan changed since then fails with CONFLICT evaluation_plan_changed, so re-read the Outcome). A cognitive_walkthrough inspects the design and is not evidence from real users, so it cannot judge a Criterion met (VALIDATION_ERROR). " +
        "Task acceptance or publication is not an effect: without observed Evidence record insufficient_evidence. One judgment per fixed Success Criterion (every Criterion exactly once) with " +
        "verdict met | not_met | insufficient_evidence, a rationale, and evidenceIds (ids from get_evaluator_context's " +
        "targets[].execution.evidence of any Target Project). met and not_met require at least one evidenceId; use insufficient_evidence when the Evidence could not " +
        "be observed - never guess success or failure. The overall result is derived by Compass, not sent: achieved only when every " +
        "Criterion is met; failed when any Criterion is not_met; otherwise insufficient_evidence. Execution being accepted does not " +
        "make an Outcome achieved. The Evaluation is append-only, keeps a snapshot of the Outcome and of every Target's Execution " +
        "Summary and Evidence references (per Project) at evaluation time, and is stored with the Principal from the Bearer and runRef. requestKey makes a resend " +
        "idempotent (recorded: false, the same Evaluation); the same requestKey with different content fails with CONFLICT. " +
        "It does not change the Outcome, its Success Criteria or the Execution result, and it does not decide the next Outcome or " +
        "Intent completion: a new Evaluation adds one outcome_evaluated Runtime event (a resend adds none) so that the Runtime starts " +
        "a Strategist. An Outcome of another Workspace fails with NOT_FOUND; a non-active Outcome, an Outcome that is not evaluable " +
        "(reason no_targets, replan_required or awaiting_execution, with comma-separated unfinishedProjectIds; a part of the Target Projects finishing is " +
        "not enough; the Targets and their Summary/Evidence are re-checked in the saving transaction, so a Target added or removed " +
        "or an Execution reflected during the evaluation is re-read instead of being left out, and reason targets_changed means they " +
        "kept changing), an Intent that is no longer active (reason intent_not_active) or an " +
        "archived Workspace fails with CONFLICT. " +
        "Requires Authorization: Bearer <AgentName> with an evaluator Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: outcomeEvaluationSchema,
    },
    ({ workspaceId, outcomeId, ...input }) =>
      execute(() =>
        asActorOf(ProjectRole.EVALUATOR, () => services.recordOutcomeEvaluationUseCase.execute(principal, workspaceId, outcomeId, input)),
      ),
  );

  server.registerTool(
    "record_intent_metric_observations",
    {
      title: "Record Intent Metric Observations",
      description:
        "Record observations of a defined Intent Metric (metricKey) - 1 to 100 items, each for a distinct period: periodStart and " +
        "periodEnd (YYYY-MM-DD, inclusive, at most 366 days; a daily value uses the same date), status observed with a finite value " +
        "(in the Metric's unit; zero is a real value) or status failed with failureReason and no value (never substitute zero or an " +
        "estimate), source = { name, uri? (http(s), no credentials) } and observedAt (epoch milliseconds when the value was taken; not " +
        "in the future and not before the period started). Each period keeps append-only revisions: content (status, value, reason, " +
        "source, observedAt) identical to any existing revision of that period is a resend and is unchanged (no new revision, the " +
        "response is the latest revision, and a delayed resend never rolls back a correction); anything else becomes the next revision " +
        "(revised). Send a correction that returns to an earlier value with a new observedAt. Results are returned in input " +
        "order with kind created | revised | unchanged. Recording does not add Activity, evaluate an Outcome or complete the Intent. " +
        "An unknown metricKey or an Intent of another Workspace fails with NOT_FOUND; invalid values, periods or times fail with " +
        "VALIDATION_ERROR; a non-active Intent (reason intent_not_active) or an archived Workspace fails with CONFLICT. " +
        "Requires Authorization: Bearer <AgentName> with an evaluator Grant of the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        metricKey: z.string(),
        observations: z.array(
          z.object({
            periodStart: z.string(),
            periodEnd: z.string(),
            status: z.string(),
            value: z.number().nullable().optional(),
            failureReason: z.string().nullable().optional(),
            source: z.object({ name: z.string(), uri: z.string().nullable().optional() }),
            observedAt: z.number(),
          }),
        ),
      },
    },
    ({ workspaceId, intentId, ...input }) =>
      execute(() => services.recordIntentMetricObservationsUseCase.execute(principal, workspaceId, intentId, input)),
  );

  // Intentの観測についてのAgentの説明。入力規則はdirectionのintentExplanationSchemaが持ち、ここでは型だけを宣言する。
  server.registerTool(
    "record_intent_explanation",
    {
      title: "Record Intent Explanation",
      description:
        "Append an explanation of an Intent Metric (metricKey) for an analysis period (periodStart..periodEnd, YYYY-MM-DD, at most 366 " +
        "days), separating items by kind: fact (confirmed from records; needs basis), hypothesis (an interpretation / possible cause " +
        "- needs basedOn fact positions, confidence low|medium|high and verification: how to confirm or refute it; it is never a causal " +
        "conclusion) and proposal (a next action; needs basedOn fact/hypothesis positions). basedOn holds positions of EARLIER items in " +
        "items. basis references existing records by id and the server resolves them on read (nothing is copied): fact -> " +
        "metric_observation (an observation id of this Metric, from list_intent_metrics)|finding|evaluation; hypothesis -> " +
        "finding|synthesis|evaluation; proposal -> synthesis|decision. At least one fact is required and every fact needs a basis. " +
        "relatedOutcomeIds are Outcomes of the same Intent. Each call is the next version for the Intent+Metric; changeFromPrevious " +
        "says what changed since the previous version (ignored for the first). The same requestKey with identical content is a resend " +
        "(result: replayed); a different content with the same requestKey fails with CONFLICT (reason request_key_conflict). Recording " +
        "does not change the Intent or Outcomes and is no evidence that an Agent ran, a measure worked or the goal was achieved; a " +
        "simple before/after difference must stay a fact or a hypothesis, not an effect. An unknown metricKey or an Intent of another " +
        "Workspace fails with NOT_FOUND; unknown or out-of-Intent references and invalid structure fail with VALIDATION_ERROR; a " +
        "non-active Intent (reason intent_not_active) or an archived Workspace fails with CONFLICT. " +
        "Requires Authorization: Bearer <AgentName> with a Strategist Grant of the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        requestKey: z.string(),
        runRef: z.string(),
        metricKey: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
        changeFromPrevious: z.string().nullable().optional(),
        relatedOutcomeIds: z.array(z.string()).optional(),
        items: z.array(
          z.object({
            kind: z.string(),
            statement: z.string(),
            confidence: z.string().nullable().optional(),
            verification: z.string().nullable().optional(),
            basedOn: z.array(z.number()).optional(),
            basis: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
          }),
        ),
      },
    },
    ({ workspaceId, intentId, ...input }) =>
      execute(() => services.recordIntentExplanationUseCase.execute(principal, workspaceId, intentId, input)),
  );
  server.registerTool(
    "list_intent_explanations",
    {
      title: "List Intent Explanations",
      description:
        "List the recorded explanations of an Intent (newest first, at most 50) with metrics = the current observation state of each " +
        "Metric (unmeasured | failed | stale | observed) and explanations = items split into fact | hypothesis | proposal, each basis " +
        "resolved from the original record with state current | revised | superseded | expired | missing, relatedOutcomes, the " +
        "previous version and basisOutdated (some basis is no longer current). An empty explanations list means nothing was recorded; " +
        "do not fill it in from Metrics. An Intent of another Workspace fails with NOT_FOUND.",
      inputSchema: { workspaceId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ workspaceId, intentId }) =>
      execute(() => asWorkspaceReader(workspaceId, () => services.listIntentExplanationsUseCase.execute(workspaceId, intentId))),
  );
};
