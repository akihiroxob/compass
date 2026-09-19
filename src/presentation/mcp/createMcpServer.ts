import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConflictError } from "../../application/error/ConflictError.ts";
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
      error instanceof ConflictError
    ) {
      return {
        ...result({
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof ValidationError ? { issues: error.issues } : {}),
            ...(error instanceof ConflictError ? error.details : {}),
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
    "update_project",
    {
      title: "Update Project",
      description:
        "Update a Compass Project. Omitted fields are unchanged; null or an empty string clears description and vision; " +
        "principles, constraints, repositories and resources replace the whole list when given. " +
        "Repository/Resource items keep their identity when their existing id is included.",
      inputSchema: projectUpdateSchema,
    },
    ({ projectId, ...input }) => execute(() => services.updateProjectUseCase.execute(projectId, input)),
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
    ({ projectId, ...input }) => execute(() => services.createIntentUseCase.execute(projectId, input)),
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
      execute(() => services.updateIntentUseCase.execute(projectId, intentId, input)),
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
      execute(() => services.abandonIntentUseCase.execute(projectId, intentId, { reason })),
  );

  return server;
};
