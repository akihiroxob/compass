import { z } from "zod";
import { projectRoles, workspaceRoles } from "@compass/access";
import { skillStatuses } from "../application/agentContext/AgentAssets.ts";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const registerAgentContextTools = (server: McpServer, context: McpRequestContext) => {
  const { services, caller, principal, authorization } = context;
  // Project Role向けのRole Context（Progressive Disclosure）。起動時はRole・Policy・Skill metadataとProject・所属Workspace要約・担当Outcomeだけを返し、Skill本文はJITで取得させる。
  server.registerTool(
    "get_role_context",
    {
      title: "Get Role Context",
      description:
        "Get what a Project Role Agent (manager, worker, reviewer) needs when it starts: the Role Definition (roles/<role>.md without " +
        "frontmatter) and the Skill names it uses, the shared Policies, metadata of those Skills (name, description, status, version, " +
        "requiredKnowledge, namespaced requiredTools; no Skill body), the Project (id, workspaceId, name, description as the Project " +
        "purpose, status), Project Resources (repositories, resources), workspace (a summary of the Project's own Workspace: Mission, " +
        "Vision, Principles, Constraints, status; no other Projects or Workspace Activities), outcomes (the active Outcomes this " +
        "Project is a Target of, most recently targeted first: id, intentId, title, description, hypothesis, status, the fixed " +
        "successCriteria and the correlationId of their Stories; empty when the Project has no Target) and the recent Project " +
        "Activity summaries (activity: newest first, summary and refs only, same shape as list_activities). Fetch a Skill body and its requiredKnowledge with get_skill_context only when the work needs it, " +
        "an Activity body with get_activity, older Activities with list_activities, and read Project documents from their " +
        "Repository / Docs. unavailable lists inputs that are not connected yet (currently none); do not assume or invent them. source.revision is the deployed Compass Git SHA, or null if unspecified. Does not replace " +
        "get_strategist_context / get_researcher_context / get_evaluator_context / get_outcome_handoff_context. Workspace Roles get their " +
        "Workspace context with get_workspace_role_context. Requires Authorization: Bearer <AgentName> with a Grant " +
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
        "their Repository / Docs. unavailable lists inputs that are not connected yet (currently none). source.revision is the deployed Compass Git SHA, or null if unspecified. " +
        "Does not replace get_strategist_context / get_researcher_context / " +
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
    "record_agent_run",
    {
      title: "Record Agent Run",
      description:
        "For a runner (Ralph, Orchestrator): record an observation of one Agent run - event started (once, with a runner-generated " +
        "unique runId), observed (the run is still being observed; extends staleAfterSeconds, default 1800) or finished (result " +
        "succeeded | failed with an optional reason such as the exit code). Times are the Server's. It is an observation reported by the " +
        "runner, not proof that a process is alive, and it is not written to Activity. With an Agent Credential (or a trusted-local Agent " +
        "name) the run is the caller's own: X-Compass-Active-Role is required and the Principal must hold that Role's Grant in scope " +
        "(an Agent Credential only in its own scope). With a Runtime Credential that has the agent:run:write scope of the same " +
        "Workspace / Project, pass principalId and role of the started Agent; that Principal must hold the Role Grant in scope. A resend " +
        "of the same runId is idempotent (recorded: false); the same runId for another Principal, scope or Role, or a different result " +
        "for a finished run, fails with CONFLICT. observed / finished without started fails with NOT_FOUND. Credentials in reason are " +
        "redacted. workRef (task, intent, outcome, evaluation, research_request, consultation) is optional.",
      inputSchema: {
        runId: z.string(),
        scope: z.object({ kind: z.enum(["workspace", "project"]), id: z.string() }),
        event: z.enum(["started", "observed", "finished"]),
        source: z.enum(["ralph", "orchestrator"]),
        principalId: z.string().optional(),
        role: z.enum(projectRoles).optional(),
        provider: z.string().optional(),
        workRef: z.object({ kind: z.string(), id: z.string() }).optional(),
        staleAfterSeconds: z.number().optional(),
        result: z.enum(["succeeded", "failed"]).optional(),
        reason: z.string().optional(),
      },
    },
    (input) => execute(() => services.recordAgentRunUseCase.execute(caller, authorization.activeRole, input)),
  );
};
