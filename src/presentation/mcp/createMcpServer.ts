import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectRole, projectRoles } from "../../constants/ProjectRole.ts";
import { ConflictError } from "../../application/error/ConflictError.ts";
import { ForbiddenError } from "../../application/error/ForbiddenError.ts";
import { InstructionUnavailableError } from "../../application/error/InstructionUnavailableError.ts";
import { NotFoundError } from "../../application/error/NotFoundError.ts";
import { UnauthenticatedError } from "../../application/error/UnauthenticatedError.ts";
import { ValidationError } from "../../application/error/ValidationError.ts";
import type { Principal } from "../../application/service/ProjectAuthorizationService.ts";
import type { ApplicationServices } from "../../container.ts";

const nullableText = (maximum: number) => z.string().max(maximum).nullable().optional();
const namedLink = { name: z.string(), url: z.string() };

const projectInputSchema = {
  name: z.string(),
  description: nullableText(1_000),
  mission: z.string(),
  vision: nullableText(2_000),
  principles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  repositories: z.array(z.object(namedLink)).optional(),
  resources: z.array(z.object({ ...namedLink, kind: nullableText(100) })).optional(),
};

const projectUpdateSchema = {
  projectId: z.string().min(1),
  name: z.string().optional(),
  description: nullableText(1_000),
  mission: z.string().optional(),
  vision: nullableText(2_000),
  principles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  repositories: z.array(z.object({ id: z.string().optional(), ...namedLink })).optional(),
  resources: z
    .array(z.object({ id: z.string().optional(), ...namedLink, kind: nullableText(100) }))
    .optional(),
};

// Intentの入力規則はshared/intentSchemaが持つ。ここでは型だけを宣言し、上限などはuse caseで検証する。
const intentCreateSchema = {
  projectId: z.string().min(1),
  title: z.string(),
  desiredState: z.string(),
  completionDefinition: z.string().nullable().optional(),
};

const intentUpdateSchema = {
  projectId: z.string().min(1),
  intentId: z.string().min(1),
  title: z.string().optional(),
  desiredState: z.string().optional(),
  completionDefinition: z.string().nullable().optional(),
};

// Outcomeの入力規則もshared/outcomeSchemaが持つ。成功条件は作成時に固定され、更新用のschemaには含めない。
const outcomeCreateSchema = {
  projectId: z.string().min(1),
  intentId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  hypothesis: z.string().nullable().optional(),
  rationale: z.string(),
  successCriteria: z.array(
    z.object({ description: z.string(), measurement: z.string(), target: z.string().nullable().optional() }),
  ),
};

const outcomeUpdateSchema = {
  projectId: z.string().min(1),
  intentId: z.string().min(1),
  outcomeId: z.string().min(1),
  title: z.string().optional(),
  hypothesis: z.string().nullable().optional(),
  // 固定項目は受け付けないが、schemaに無いとzodが黙って捨てるため宣言し、use caseがCONFLICTで拒否できるようにする。
  description: z.unknown().optional(),
  rationale: z.unknown().optional(),
  successCriteria: z.unknown().optional(),
};

// Researchの入力規則はshared/researchSchemaが持つ。ここでは型だけを宣言する。
// principalIdは入力に持たない。来歴のPrincipalはBearerから解決した値だけを使う。
const researchRequestRef = { projectId: z.string().min(1), requestId: z.string().min(1) };
const researchProvenance = { requestKey: z.string(), runRef: z.string() };
const researchTextList = z.array(z.string()).optional();

const researchResultSchema = {
  ...researchRequestRef,
  ...researchProvenance,
  summary: z.string(),
  budgetUsed: z.number().optional(),
  evidenceRefs: z
    .array(
      z.object({
        kind: z.string(),
        uri: z.string(),
        retrievedAt: z.number(),
        versionHash: z.string().nullable().optional(),
      }),
    )
    .optional(),
  findings: z
    .array(
      z.object({
        statement: z.string(),
        confidence: z.string(),
        observedAt: z.number(),
        expiresAt: z.number().nullable().optional(),
        evidenceIndexes: z.array(z.number()),
        conflictsWithFindingIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  unknowns: researchTextList,
  options: researchTextList,
  risks: researchTextList,
};

const researchSynthesisSchema = {
  ...researchRequestRef,
  ...researchProvenance,
  conclusion: z.string(),
  findingIds: z.array(z.string()),
  risks: researchTextList,
  options: researchTextList,
  unknowns: researchTextList,
  validAsOf: z.number(),
  supersedesId: z.string().nullable().optional(),
};

const result = (value: unknown) => {
  const plainValue = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(plainValue, null, 2) }],
    structuredContent: plainValue,
  };
};

const execute = async (operation: () => Promise<unknown>) => {
  try {
    return result(await operation());
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof NotFoundError ||
      error instanceof ConflictError ||
      error instanceof ForbiddenError ||
      error instanceof UnauthenticatedError ||
      error instanceof InstructionUnavailableError
    ) {
      return {
        ...result({
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof ValidationError ? { issues: error.issues } : {}),
            ...(error instanceof ConflictError || error instanceof ForbiddenError ? error.details : {}),
          },
        }),
        isError: true,
      };
    }
    throw error;
  }
};

/** principalはAuthorizationヘッダーから解決した値だけ。tool入力やsession IDは認証情報として読まない。 */
export const createMcpServer = (services: ApplicationServices, principal: Principal = null) => {
  const authorization = services.projectAuthorizationService;
  // 検査の規則はapplication serviceが持つ。handlerはPrincipalとprojectIdを渡すだけ。
  const asStrategist = <T>(projectId: string, operation: () => Promise<T>) =>
    authorization.asRole(principal, projectId, ProjectRole.STRATEGIST, operation);
  // 来歴のPrincipalはBearerから解決した値だけ。tool入力のprincipalIdは受け付けない。
  const asResearcher = async <T>(projectId: string, operation: (principalId: string) => Promise<T>) =>
    operation(await authorization.requireRole(principal, projectId, ProjectRole.RESEARCHER));
  // Direction（Project・Intent）の管理操作。StrategistまたはResearcherのGrantを持つPrincipalには拒否する（職務分離）。
  const unlessDirectionRole = <T>(projectId: string, operation: () => Promise<T>) =>
    authorization.unlessRole(principal, projectId, ProjectRole.STRATEGIST, () =>
      authorization.unlessRole(principal, projectId, ProjectRole.RESEARCHER, operation),
    );

  const server = new McpServer(
    { name: "compass", version: "0.1.0" },
    { instructions: "Compass Direction context server" },
  );

  server.registerTool(
    "create_project",
    { title: "Create Project", description: "Create a Compass Project.", inputSchema: projectInputSchema },
    (input) => execute(() => services.createProjectUseCase.execute(input)),
  );
  server.registerTool(
    "update_project",
    {
      title: "Update Project",
      description:
        "Update a Compass Project. Omitted fields are unchanged; null or an empty string clears description and vision; " +
        "principles, constraints, repositories and resources replace the whole list when given. " +
        "Repository/Resource items keep their identity when their existing id is included.",
      inputSchema: projectUpdateSchema,
    },
    ({ projectId, ...input }) =>
      execute(() => unlessDirectionRole(projectId, () => services.updateProjectUseCase.execute(projectId, input))),
  );
  server.registerTool(
    "list_projects",
    { title: "List Projects", description: "List Compass Projects.", inputSchema: {} },
    () => execute(async () => ({ projects: await services.listProjectsUseCase.execute() })),
  );
  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description: "Get a Compass Project by ID.",
      inputSchema: { projectId: z.string().min(1) },
    },
    ({ projectId }) => execute(() => services.getProjectUseCase.execute(projectId)),
  );

  server.registerTool(
    "create_intent",
    {
      title: "Create Intent",
      description:
        "Create an active Intent in a Project. A Project has at most one active Intent; " +
        "creating another while one is active fails with CONFLICT. Creating an Intent does not start Strategist or Research.",
      inputSchema: intentCreateSchema,
    },
    ({ projectId, ...input }) =>
      execute(() => unlessDirectionRole(projectId, () => services.createIntentUseCase.execute(projectId, input))),
  );
  server.registerTool(
    "list_intents",
    {
      title: "List Intents",
      description: "List the Intents of a Project, newest first.",
      inputSchema: { projectId: z.string().min(1) },
    },
    ({ projectId }) =>
      execute(async () => ({ intents: await services.listIntentsUseCase.execute(projectId) })),
  );
  server.registerTool(
    "get_intent",
    {
      title: "Get Intent",
      description: "Get an Intent by ID within a Project.",
      inputSchema: { projectId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ projectId, intentId }) => execute(() => services.getIntentUseCase.execute(projectId, intentId)),
  );
  server.registerTool(
    "update_intent",
    {
      title: "Update Intent",
      description:
        "Update title, desiredState or completionDefinition of an active Intent. Omitted fields are unchanged; " +
        "null or an empty string clears completionDefinition. Abandoned or achieved Intents cannot be edited (CONFLICT).",
      inputSchema: intentUpdateSchema,
    },
    ({ projectId, intentId, ...input }) =>
      execute(() =>
        unlessDirectionRole(projectId, () => services.updateIntentUseCase.execute(projectId, intentId, input)),
      ),
  );
  server.registerTool(
    "abandon_intent",
    {
      title: "Abandon Intent",
      description:
        "Abandon an active Intent with an optional reason. Abandoned Intents cannot be reactivated; create a new Intent instead.",
      inputSchema: {
        projectId: z.string().min(1),
        intentId: z.string().min(1),
        reason: z.string().nullable().optional(),
      },
    },
    ({ projectId, intentId, reason }) =>
      execute(() =>
        unlessDirectionRole(projectId, () => services.abandonIntentUseCase.execute(projectId, intentId, { reason })),
      ),
  );

  // Role文書は静的で機密を含まない。Agentが起動直後に自力で読めるよう、Bearerもgrantも要求しない。
  server.registerTool(
    "get_role_instructions",
    {
      title: "Get Role Instructions",
      description:
        "Get operational instructions for a Project Role. With includeShared=true the shared agent/role-policy.md is returned first. " +
        "No Authorization is required. Fails with INSTRUCTION_UNAVAILABLE if an instruction file cannot be read.",
      inputSchema: { role: z.enum(projectRoles), includeShared: z.boolean().optional() },
    },
    ({ role, includeShared }) => execute(() => services.instructionService.getRoleInstructions(role, includeShared)),
  );
  server.registerTool(
    "get_strategist_context",
    {
      title: "Get Strategist Context",
      description:
        "Get what a Strategist needs to decide the next Outcome: the Project (Mission, Vision, Principles, Constraints, " +
        "Repositories, Resources), its active Intent (null if none), and every Outcome under that Intent including cancelled ones. " +
        "unavailable lists inputs that are not implemented yet (research, evaluation, evidence); do not assume or invent them. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: { projectId: z.string().min(1) },
    },
    ({ projectId }) => execute(() => services.getStrategistContextUseCase.execute(principal, projectId)),
  );
  server.registerTool(
    "create_outcome",
    {
      title: "Create Outcome",
      description:
        "Register an Outcome (with its Success Criteria) under an active Intent as a Strategist decision. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise). " +
        "rationale records why this Outcome was chosen. Success Criteria are fixed at creation (1-10 items) and cannot be edited later; " +
        "to change them, cancel the Outcome and create a new one. Outcomes are never generated from an Intent automatically, " +
        "and Research is not required.",
      inputSchema: outcomeCreateSchema,
    },
    ({ projectId, intentId, ...input }) =>
      execute(() =>
        asStrategist(projectId, async () => ({
          outcome: await services.createOutcomeUseCase.execute(projectId, intentId, input),
        })),
      ),
  );
  server.registerTool(
    "list_outcomes",
    {
      title: "List Outcomes",
      description: "List the Outcomes of an Intent with their Success Criteria, newest first.",
      inputSchema: { projectId: z.string().min(1), intentId: z.string().min(1) },
    },
    ({ projectId, intentId }) =>
      execute(async () => ({ outcomes: await services.listOutcomesUseCase.execute(projectId, intentId) })),
  );
  server.registerTool(
    "get_outcome",
    {
      title: "Get Outcome",
      description: "Get an Outcome and its Success Criteria by ID within a Project and Intent.",
      inputSchema: { projectId: z.string().min(1), intentId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ projectId, intentId, outcomeId }) =>
      execute(async () => ({ outcome: await services.getOutcomeUseCase.execute(projectId, intentId, outcomeId) })),
  );
  server.registerTool(
    "update_outcome",
    {
      title: "Update Outcome",
      description:
        "Update title or hypothesis of an active Outcome. Omitted fields are unchanged; null or an empty string clears hypothesis. " +
        "description, rationale and successCriteria are fixed at creation and are rejected with CONFLICT. Cancelled Outcomes cannot be edited.",
      inputSchema: outcomeUpdateSchema,
    },
    ({ projectId, intentId, outcomeId, ...input }) =>
      execute(() =>
        asStrategist(projectId, async () => ({
          outcome: await services.updateOutcomeUseCase.execute(projectId, intentId, outcomeId, input),
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
        projectId: z.string().min(1),
        intentId: z.string().min(1),
        outcomeId: z.string().min(1),
        reason: z.string(),
      },
    },
    ({ projectId, intentId, outcomeId, reason }) =>
      execute(() =>
        asStrategist(projectId, async () => ({
          outcome: await services.cancelOutcomeUseCase.execute(projectId, intentId, outcomeId, { reason }),
        })),
      ),
  );

  server.registerTool(
    "get_researcher_context",
    {
      title: "Get Researcher Context",
      description:
        "Get what a Researcher needs to work on one Research Request: the Project snapshot (Mission, Vision, Principles, Constraints, " +
        "Repositories, Resources), the request (question, scope, completionCondition, status, deadline), the origin Intent (null for project_watch), " +
        "the remaining budget, results and syntheses already registered for this request, and related Findings with their Evidence references " +
        "from other requests of the same origin (newest first, capped). unavailable lists inputs that are not implemented yet; do not assume them. " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchRequestRef,
    },
    ({ projectId, requestId }) =>
      execute(() => services.getResearcherContextUseCase.execute(principal, projectId, requestId)),
  );
  server.registerTool(
    "list_research_requests",
    {
      title: "List Research Requests",
      description:
        "List the Research Requests of a Project, newest first, optionally filtered by originIntentId or status " +
        "(requested, running, completed, insufficient, not_needed, cancelled). " +
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        projectId: z.string().min(1),
        originIntentId: z.string().optional(),
        status: z.string().optional(),
      },
    },
    ({ projectId, ...filter }) =>
      execute(() =>
        asResearcher(projectId, async () => ({
          requests: await services.listResearchRequestsUseCase.execute(projectId, filter),
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
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchResultSchema,
    },
    ({ projectId, requestId, ...input }) =>
      execute(() =>
        asResearcher(projectId, async (principalId) => ({
          result: await services.registerResearchResultUseCase.execute(projectId, requestId, { ...input, principalId }),
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
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: researchSynthesisSchema,
    },
    ({ projectId, requestId, ...input }) =>
      execute(() =>
        asResearcher(projectId, async (principalId) => ({
          synthesis: await services.registerResearchSynthesisUseCase.execute(projectId, requestId, {
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
        "Requires Authorization: Bearer <AgentName> with a researcher Grant in the Project (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        ...researchRequestRef,
        conclusion: z.string(),
        stopReason: z.string().nullable().optional(),
      },
    },
    ({ projectId, requestId, ...input }) =>
      execute(() =>
        asResearcher(projectId, async () => ({
          request: await services.completeResearchRequestUseCase.execute(projectId, requestId, input),
        })),
      ),
  );

  return server;
};
