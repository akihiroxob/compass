import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { directionDecisionRecordTypes } from "@compass/direction";
import { agentPrincipalOf, ProjectRole, projectRoles, workspaceRoles, type Caller } from "@compass/access";
import type { AuthMode } from "../auth/humanAuthConfig.ts";
import type { OperationServices } from "../bootstrap/createApplicationServices.ts";
import { registerActivityTools } from "./registerActivityTools.ts";
import { registerExecutionTools } from "./registerExecutionTools.ts";
import { withActivityActor } from "../application/activityActor.ts";
import { skillStatuses } from "../application/agentContext/AgentAssets.ts";
import { execute } from "./toolExecution.ts";

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
  workspaceId: z.string().min(1),
  title: z.string(),
  desiredState: z.string(),
  completionDefinition: z.string().nullable().optional(),
};

const intentUpdateSchema = {
  workspaceId: z.string().min(1),
  intentId: z.string().min(1),
  title: z.string().optional(),
  desiredState: z.string().optional(),
  completionDefinition: z.string().nullable().optional(),
};

// Outcomeの入力規則もshared/outcomeSchemaが持つ。成功条件は作成時に固定され、更新用のschemaには含めない。
const outcomeCreateSchema = {
  workspaceId: z.string().min(1),
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
  workspaceId: z.string().min(1),
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
const researchRequestRef = { workspaceId: z.string().min(1), requestId: z.string().min(1) };
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

// Direction Decisionの入力規則もshared/directionDecisionSchemaが持つ。ここでは型だけを宣言する。
// principalIdは入力に持たない。来歴のPrincipalはBearerから解決した値だけを使う。
const usedSynthesisRefSchema = z.object({ synthesisId: z.string().min(1), version: z.number().int().min(1) });

const directionDecisionCommonSchema = {
  workspaceId: z.string().min(1),
  intentId: z.string().min(1),
  judgment: z.string(),
  reason: z.string(),
  options: z.array(z.string()).optional(),
  usedSyntheses: z.array(usedSynthesisRefSchema).optional(),
  usedFindingIds: z.array(z.string()).optional(),
  requestKey: z.string(),
  runRef: z.string(),
  evaluationId: z.string().optional(),
};

// additional_researchだけが`research`（Strategistが決める調査計画）を必須とする。規則はshared/directionDecisionSchemaが持つ。
const additionalResearchPlanMcpSchema = z.object({
  question: z.string(),
  scope: z.string(),
  completionCondition: z.string(),
  budgetTotal: z.number().int(),
  deadlineAt: z.number().int().nullable().optional(),
});

const createDirectionDecisionMcpSchema = {
  ...directionDecisionCommonSchema,
  type: z.enum(directionDecisionRecordTypes),
  research: additionalResearchPlanMcpSchema.optional(),
};

const decideNextOutcomeMcpSchema = {
  ...directionDecisionCommonSchema,
  outcome: z.object(outcomeCreateSchema).omit({ workspaceId: true, intentId: true }),
};

// ADR Handoffの入力規則もshared/adrHandoffSchemaが持つ。ここでは型だけを宣言する。
const adrHandoffRequestMcpSchema = {
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
  repositoryId: z.string().min(1),
  correlationId: z.string().min(1),
  requestKey: z.string().min(1),
};

const adrReferenceMcpSchema = {
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
  repositoryId: z.string().min(1),
  path: z.string().min(1),
  commitSha: z.string().min(1),
  pullRequestUrl: z.string().nullable().optional(),
  correlationId: z.string().min(1),
  requestKey: z.string().min(1),
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

// Outcome Evaluationの入力規則はshared/outcomeEvaluationSchemaが持つ。ここでは型だけを宣言する。
// 総合結果は入力に持たない（Criterionの判定から導出する）。principalIdも入力に持たない。
const outcomeEvaluationSchema = {
  workspaceId: z.string().min(1),
  outcomeId: z.string().min(1),
  requestKey: z.string(),
  runRef: z.string(),
  criteria: z.array(
    z.object({
      criterionId: z.string(),
      verdict: z.string(),
      rationale: z.string(),
      evidenceIds: z.array(z.string()).optional(),
    }),
  ),
};

/**
 * callerはAuthorizationヘッダーから解決した値だけ。tool入力やsession IDは認証情報として読まない。
 * Agent向けtoolはRole Grantで（Runtime Credentialは種別違いのためPrincipalなし）、Runtime向けtoolはscopeで認可する。
 */
export const createMcpServer = (
  services: OperationServices,
  caller: Caller = null,
  /** 認証mode。remoteではHuman管理・入力toolを登録せず、匿名にはRole文書だけを見せる。 */
  options: { mode?: AuthMode } = {},
) => {
  const remote = options.mode === "remote";
  const principal = agentPrincipalOf(caller);
  const authorization = services.projectAuthorizationService;
  const runtimeAuthorization = services.runtimeAuthorizationService;
  const roleScope = services.roleScopeAuthorizationService;
  const workspaceScope = (workspaceId: string) => ({ kind: "workspace" as const, id: workspaceId });
  // Project参照・一覧はremote modeまたはactiveRole指定時にGrantを要求する（activeRole指定時はそのRoleのGrantだけ）。
  // trusted-localのheaderなしは互換のためGrantを問わない。
  const requiresGrant = remote || authorization.hasActiveRole;
  const asGrantedReader = async <T>(projectId: string, operation: () => Promise<T>) => {
    if (requiresGrant) await authorization.requireAnyRole(principal, projectId);
    return operation();
  };
  // Workspace Directionの参照。条件はProject参照と同じで、WorkspaceのRole Grantで検査する（Project Grantから継承しない）。
  const asWorkspaceReader = async <T>(workspaceId: string, operation: () => Promise<T>) => {
    if (requiresGrant) await roleScope.requireAnyRole(principal, workspaceScope(workspaceId));
    return operation();
  };
  // 検査の規則はapplication serviceが持つ。handlerはPrincipalとworkspaceIdを渡すだけ。
  // 認可したPrincipalとRoleを操作の間だけ固定し、Directionの状態変更から生成するcanonical Activityの操作者にする。
  const asWorkspaceRole = async <T>(workspaceId: string, role: ProjectRole, operation: (principalId: string) => Promise<T>) => {
    const principalId = await roleScope.requireRole(principal, workspaceScope(workspaceId), role);
    return withActivityActor({ principalId, role }, () => operation(principalId));
  };
  const asStrategist = <T>(workspaceId: string, operation: () => Promise<T>) =>
    asWorkspaceRole(workspaceId, ProjectRole.STRATEGIST, () => operation());
  // Direction Decisionは来歴にprincipalIdを保存するため、認可と同時にBearerから解決したprincipalIdを受け取る。
  const asStrategistWithPrincipal = <T>(workspaceId: string, operation: (principalId: string) => Promise<T>) =>
    asWorkspaceRole(workspaceId, ProjectRole.STRATEGIST, operation);
  // 来歴のPrincipalはBearerから解決した値だけ。tool入力のprincipalIdは受け付けない。
  const asResearcher = <T>(workspaceId: string, operation: (principalId: string) => Promise<T>) =>
    asWorkspaceRole(workspaceId, ProjectRole.RESEARCHER, operation);
  // 認可をuse caseが行う操作（Evaluation）。Principalがあれば、use caseが要求するRoleを操作者の立場にする。
  const asActorOf = <T>(role: ProjectRole, operation: () => Promise<T>) =>
    principal === null ? operation() : withActivityActor({ principalId: principal, role }, operation);
  // Projectの管理操作。Strategist・Researcher・EvaluatorのGrantを持つPrincipalには拒否する（職務分離）。
  // 操作者の立場はactiveRole（無ければ管理操作のoperator）。Principalなしのtrusted-local呼出しは`system`になる。
  // Direction RoleはWorkspace所有のため、所属WorkspaceのDirection Role Grantも同じく拒否する。
  const unlessDirectionRole = async <T>(projectId: string, operation: () => Promise<T>) => {
    await roleScope.requireNoWorkspaceGrant(principal, (await services.getProjectUseCase.execute(projectId)).workspaceId);
    return authorization.unlessRole(principal, projectId, ProjectRole.STRATEGIST, () =>
      authorization.unlessRole(principal, projectId, ProjectRole.RESEARCHER, () =>
        authorization.unlessRole(principal, projectId, ProjectRole.EVALUATOR, () =>
          principal === null
            ? operation()
            : withActivityActor({ principalId: principal, role: authorization.activeRole ?? "operator" }, operation),
        ),
      ),
    );
  };
  // Workspace DirectionのHuman管理・入力操作（Intent）。WorkspaceのDirection Role Grantを持つPrincipalとactiveRole指定を拒否する。
  const asWorkspaceOperator = async <T>(workspaceId: string, operation: () => Promise<T>) => {
    await roleScope.requireNoWorkspaceRole(principal, workspaceId);
    return principal === null ? operation() : withActivityActor({ principalId: principal, role: "operator" }, operation);
  };

  const server = new McpServer(
    { name: "compass", version: "0.1.0" },
    { instructions: "Compass MCP server: Direction (Workspace Intent, Research, Outcome) and Execution (Project Story, Task, Claim) tools" },
  );

  // Role文書は静的で機密を含まない。Agentが起動直後に自力で読めるよう、Bearerもgrantも要求しない。
  const registerRoleInstructions = () =>
    server.registerTool(
      "get_role_instructions",
      {
        title: "Get Role Instructions",
        description:
          "Get operational instructions for a Project Role (roles/<role>.md as-is). With includeShared=true the shared policies/role-policy.md is returned first. " +
          "No Authorization is required. Fails with INSTRUCTION_UNAVAILABLE if an instruction file cannot be read.",
        inputSchema: { role: z.enum(projectRoles), includeShared: z.boolean().optional() },
      },
      ({ role, includeShared }) => execute(() => services.agentContextService.getRoleInstructions(role, includeShared)),
    );
  // remote modeの匿名呼出しはRole文書以外を登録しない（未知toolとして拒否）。Credentialの検証はapp（resolveCaller）が行う。
  if (remote && caller === null) {
    registerRoleInstructions();
    return server;
  }

  // Project作成・構想更新・Intent操作はHumanの管理・入力操作で、Web UIが正規入口。remote modeではMCPへ登録しない。
  if (!remote) server.registerTool(
    "create_project",
    { title: "Create Project", description: "Create a Compass Project.", inputSchema: projectInputSchema },
    (input) => execute(() => services.createProjectUseCase.execute(input)),
  );
  if (!remote) server.registerTool(
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
    {
      title: "List Projects",
      description:
        "List Compass Projects. In remote mode only the Projects where the calling Agent Credential's Principal has a Role Grant are listed; " +
        "with X-Compass-Active-Role only the Projects where the Principal has a Grant of that Role are listed.",
      inputSchema: {},
    },
    () =>
      execute(async () => {
        const projects = await services.listProjectsUseCase.execute();
        if (!requiresGrant) return { projects };
        const granted = new Set(await authorization.listGrantedProjectIds(principal));
        return { projects: projects.filter((project) => granted.has(project.id)) };
      }),
  );
  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description:
        "Get a Compass Project by ID. The response includes workspaceId (the owning Workspace) and that Workspace's mission, vision, principles and constraints.",
      inputSchema: { projectId: z.string().min(1) },
    },
    ({ projectId }) => execute(() => asGrantedReader(projectId, () => services.getProjectUseCase.execute(projectId))),
  );

  if (!remote) server.registerTool(
    "create_intent",
    {
      title: "Create Intent",
      description:
        "Create an active Intent in a Workspace. A Workspace has at most one active Intent; " +
        "creating another while one is active fails with CONFLICT. Creating an Intent does not start Strategist or Research. " +
        "An archived Workspace fails with CONFLICT (workspaceStatus archived).",
      inputSchema: intentCreateSchema,
    },
    ({ workspaceId, ...input }) =>
      execute(() => asWorkspaceOperator(workspaceId, () => services.createIntentUseCase.execute(workspaceId, input))),
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
  if (!remote) server.registerTool(
    "update_intent",
    {
      title: "Update Intent",
      description:
        "Update title, desiredState or completionDefinition of an active Intent. Omitted fields are unchanged; " +
        "null or an empty string clears completionDefinition. Abandoned or achieved Intents cannot be edited (CONFLICT).",
      inputSchema: intentUpdateSchema,
    },
    ({ workspaceId, intentId, ...input }) =>
      execute(() =>
        asWorkspaceOperator(workspaceId, () => services.updateIntentUseCase.execute(workspaceId, intentId, input)),
      ),
  );
  if (!remote) server.registerTool(
    "abandon_intent",
    {
      title: "Abandon Intent",
      description:
        "Abandon an active Intent with an optional reason. Abandoned Intents cannot be reactivated; create a new Intent instead.",
      inputSchema: {
        workspaceId: z.string().min(1),
        intentId: z.string().min(1),
        reason: z.string().nullable().optional(),
      },
    },
    ({ workspaceId, intentId, reason }) =>
      execute(() =>
        asWorkspaceOperator(workspaceId, () => services.abandonIntentUseCase.execute(workspaceId, intentId, { reason })),
      ),
  );

  registerRoleInstructions();
  // Role Context（Progressive Disclosure）。起動時はRole・Policy・Skill metadataとProject情報だけを返し、Skill本文はJITで取得させる。
  server.registerTool(
    "get_role_context",
    {
      title: "Get Role Context",
      description:
        "Get what an Agent needs when it starts in a Role: the Role Definition (roles/<role>.md without frontmatter) and the Skill names it uses, " +
        "the shared Policies, metadata of those Skills (name, description, status, version, requiredKnowledge, namespaced requiredTools; " +
        "no Skill body), the Project's basic information (Mission, Vision, Principles, Constraints, status), Project Resources " +
        "(repositories, resources) and the recent Activity summaries (activity: newest first, summary and refs only, same shape as " +
        "list_activities). Fetch a Skill body and its requiredKnowledge with get_skill_context only when the work needs it, " +
        "an Activity body with get_activity, older Activities with list_activities, and read Project documents from their " +
        "Repository / Docs. unavailable lists inputs that are not connected yet (currently none); do not assume or invent them. source.revision is the Git commit the Role, Policy and Skill " +
        "files were read from (source.dirty=true means uncommitted changes; null when not available). Does not replace " +
        "get_strategist_context / get_researcher_context / get_evaluator_context. Workspace Roles get their Workspace context with " +
        "get_workspace_role_context. Requires Authorization: Bearer <AgentName> with a Grant " +
        "of the requested role in the Project (with X-Compass-Active-Role it must be the same role); UNAUTHENTICATED / FORBIDDEN otherwise. " +
        "Fails with INSTRUCTION_UNAVAILABLE if a Role, Policy or Skill file cannot be read.",
      inputSchema: { projectId: z.string().min(1), role: z.enum(projectRoles) },
    },
    ({ projectId, role }) => execute(() => services.getRoleContextUseCase.execute(principal, projectId, role)),
  );
  // Workspace Role向けのRole Context。scopeとRoleを入力で明示し、Project向けのget_role_contextとは別のtoolにする。
  server.registerTool(
    "get_workspace_role_context",
    {
      title: "Get Workspace Role Context",
      description:
        "Get what a Workspace Role Agent (strategist, researcher, evaluator) needs when it starts: the Role Definition " +
        "(roles/<role>.md without frontmatter) and the Skill names it uses, the shared Policies, metadata of those Skills (no Skill body), " +
        "the Workspace (Mission, Vision, Principles, Constraints, status), projects (the Workspace's active Projects, most recently " +
        "updated first: id, name, description as the Project purpose, status and Repository / Resource references with name, url and kind; " +
        "no Story, Task or Resource content) and the recent Workspace Activity summaries (activity: newest first, summary and refs only, " +
        "same shape as list_workspace_activities; Project Activities are not included). Fetch a Skill body with get_skill_context, " +
        "an Activity body with get_workspace_activity, older Activities with list_workspace_activities, and read Project documents from " +
        "their Repository / Docs. unavailable lists inputs that are not connected yet (currently none). source.revision is the Git commit " +
        "the Role, Policy and Skill files were read from. Does not replace get_strategist_context / get_researcher_context / " +
        "get_evaluator_context. Requires Authorization: Bearer <AgentName> with a Workspace Role Grant of the requested role in the " +
        "Workspace (with X-Compass-Active-Role it must be the same role; Project Grants do not count); UNAUTHENTICATED / FORBIDDEN " +
        "otherwise. Fails with INSTRUCTION_UNAVAILABLE if a Role, Policy or Skill file cannot be read.",
      inputSchema: { workspaceId: z.string().min(1), role: z.enum(workspaceRoles) },
    },
    ({ workspaceId, role }) => execute(() => services.getWorkspaceRoleContextUseCase.execute(principal, workspaceId, role)),
  );
  // Skillは認可を担わない静的な手順書。Roleとの対応はRole Definitionのskillsだけで表す。
  server.registerTool(
    "list_skills",
    {
      title: "List Skills",
      description:
        "List Skill metadata (no body) sorted by name, with source (Git revision). role narrows to the Skills referenced by roles/<role>.md; " +
        "it is not an authorization check. Fails with INSTRUCTION_UNAVAILABLE if a Skill file cannot be read.",
      inputSchema: { status: z.enum(skillStatuses).optional(), role: z.enum(projectRoles).optional() },
    },
    ({ status, role }) => execute(() => services.agentContextService.listSkills({ status, role })),
  );
  server.registerTool(
    "get_skill_context",
    {
      title: "Get Skill Context",
      description:
        "Get a Skill body and the content of its requiredKnowledge (knowledge/<path>), with source (Git revision). " +
        "NOT_FOUND for an unknown Skill; INSTRUCTION_UNAVAILABLE if the Skill or a required Knowledge file cannot be read.",
      inputSchema: { name: z.string().min(1) },
    },
    ({ name }) => execute(() => services.agentContextService.getSkillContext(name)),
  );
  server.registerTool(
    "get_strategist_context",
    {
      title: "Get Strategist Context",
      description:
        "Get what a Strategist needs to decide the next Outcome: the Workspace (Mission, Vision, Principles, Constraints, status), " +
        "its active Intent (null if none), every Outcome under that Intent including cancelled ones, " +
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
      inputSchema: { workspaceId: z.string().min(1) },
    },
    ({ workspaceId }) => execute(() => services.getStrategistContextUseCase.execute(principal, workspaceId)),
  );
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
    "create_outcome",
    {
      title: "Create Outcome",
      description:
        "Register an Outcome (with its Success Criteria) under an active Intent as a Strategist decision. " +
        "Requires Authorization: Bearer <AgentName> with a strategist Grant in the Workspace (UNAUTHENTICATED / FORBIDDEN otherwise). " +
        "rationale records why this Outcome was chosen. Success Criteria are fixed at creation (1-10 items) and cannot be edited later; " +
        "to change them, cancel the Outcome and create a new one. Outcomes are never generated from an Intent automatically, " +
        "and Research is not required.",
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
      description: "Get an Outcome and its Success Criteria by ID within a Workspace and Intent.",
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
        "Update title or hypothesis of an active Outcome. Omitted fields are unchanged; null or an empty string clears hypothesis. " +
        "description, rationale and successCriteria are fixed at creation and are rejected with CONFLICT. Cancelled Outcomes cannot be edited.",
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
    "get_orchestration_state",
    {
      title: "Get Orchestration State",
      description:
        "For an external Orchestrator: read the Project's current state used to decide which specialist Role to start. " +
        "It returns the Project status, the active Intent (id and status only), the active Intent's Outcomes with the current Work " +
        "result (Story / Task counts; null before any correlated Story), the Execution summary already reflected into the Outcome and the " +
        "latest Evaluation with the Direction Decision based on it (decisionId null while undecided), the active Intent's Research Requests " +
        "and the Project's open (requested / running) Research Requests. No content (Mission, Intent text, Research findings) is included: " +
        "the started Role reads it through its own Role Context. Reading does not change state and does not depend on Activity or " +
        "Runtime event cursors. Requires a Runtime Credential (Authorization: Bearer cmp_runtime...) of the Project with the " +
        "runtime:state:read scope; in trusted-local mode Bearer <RuntimeName> with a runtime Grant is also accepted " +
        "(UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: { projectId: z.string().min(1) },
    },
    ({ projectId }) => execute(() => services.getOrchestrationStateUseCase.execute(caller, projectId)),
  );

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
        "Save an Evaluation of an active Outcome: one judgment per fixed Success Criterion (every Criterion exactly once) with " +
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

  registerExecutionTools(server, services, caller);
  registerActivityTools(server, services, caller);

  return server;
};
