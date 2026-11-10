import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectRoles, type Caller } from "@compass/access";
import type { AuthMode } from "../auth/humanAuthConfig.ts";
import type { OperationServices } from "../application/ApplicationServices.ts";
import { registerActivityTools } from "./registerActivityTools.ts";
import { registerConsultationTools } from "./registerConsultationTools.ts";
import { registerExecutionTools } from "./registerExecutionTools.ts";
import { execute } from "./toolExecution.ts";
import { withToolContext } from "./toolContext.ts";
import { createMcpRequestContext } from "./mcpRequestContext.ts";
import { registerOrganizationTools } from "./registerOrganizationTools.ts";
import { registerIntentTools } from "./registerIntentTools.ts";
import { registerAgentContextTools } from "./registerAgentContextTools.ts";
import { registerResearchTools } from "./registerResearchTools.ts";
import { registerOutcomeTools } from "./registerOutcomeTools.ts";
import { registerDecisionTools } from "./registerDecisionTools.ts";
import { registerRuntimeTools } from "./registerRuntimeTools.ts";
import { registerEvaluationTools } from "./registerEvaluationTools.ts";

export const createMcpServer = (services: OperationServices, caller: Caller = null, options: { mode?: AuthMode } = {}) => {
  const context = createMcpRequestContext(services, caller, options);
  const { remote } = context;

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

  registerRoleInstructions();
  registerOrganizationTools(server, context);
  registerIntentTools(server, context);
  registerAgentContextTools(server, context);
  registerResearchTools(server, context);
  registerOutcomeTools(server, context);
  registerDecisionTools(server, context);
  registerRuntimeTools(server, context);
  registerEvaluationTools(server, context);

  registerExecutionTools(withToolContext(server, "work"), services, caller);
  registerActivityTools(server, services, caller);
  registerConsultationTools(withToolContext(server, "collaboration"), services, caller);

  return server;
};
