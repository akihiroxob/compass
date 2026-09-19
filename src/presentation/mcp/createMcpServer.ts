import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotFoundError } from "../../application/error/NotFoundError.ts";
import { ValidationError } from "../../application/error/ValidationError.ts";
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
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      return {
        ...result({
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof ValidationError ? { issues: error.issues } : {}),
          },
        }),
        isError: true,
      };
    }
    throw error;
  }
};

export const createMcpServer = (services: ApplicationServices) => {
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

  return server;
};
