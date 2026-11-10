import { z } from "zod";
import { execute } from "./toolExecution.ts";
import type { McpRequestContext } from "./mcpRequestContext.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectInputSchema, projectUpdateSchema } from "./toolInputSchemas.ts";

export const registerOrganizationTools = (server: McpServer, context: McpRequestContext) => {
  const { services, remote, principal, authorization, requiresGrant, asGrantedReader, unlessDirectionRole } = context;

  // Project作成・構想更新・Intentの放棄はHumanの管理操作で、Web UIが正規入口。remote modeではMCPへ登録しない。
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
        "Update a Compass Project. Omitted fields are unchanged; null or an empty string clears description; " +
        "repositories and resources replace the whole list when given. Mission, vision, principles and constraints belong to the Workspace " +
        "and are not changed here. " +
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
};
