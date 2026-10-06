import type { IntentRepository, OutcomeRepository, ProjectIntentReader, ProjectOutcomeReader } from "@compass/direction";
import { ProjectArchivedError, WorkspaceArchivedError, type ProjectRepository } from "@compass/organization";
import { ConflictError, NotFoundError } from "@compass/shared";

/**
 * S03-04までのProject入口。Workspace IDをProject IDと解釈せず、Organizationで所属を解決する。
 * 共有WorkspaceのDirectionはProject Grantだけで公開できないため、旧入口では拒否する。
 */
export const resolveProjectDirectionWorkspace = async (projects: ProjectRepository, projectId: string): Promise<string> => {
  const project = await projects.findById(projectId);
  if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
  const siblings = [...await projects.findAllInWorkspace(project.workspaceId), ...await projects.findAllInWorkspace(project.workspaceId, "archived")];
  if (siblings.length !== 1) {
    throw new ConflictError("Workspace Direction requires the Workspace entry point", { reason: "workspace_direction_required" });
  }
  return project.workspaceId;
};

export const projectDirectionUseCase = <Args extends unknown[], Result>(
  projects: ProjectRepository,
  useCase: { execute(workspaceId: string, ...args: Args): Promise<Result> },
) => ({
  execute: async (projectId: string, ...args: Args): Promise<Result> => {
    const workspaceId = await resolveProjectDirectionWorkspace(projects, projectId);
    try {
      return await useCase.execute(workspaceId, ...args);
    } catch (error) {
      if (error instanceof WorkspaceArchivedError && (await projects.findById(projectId))?.status === "archived") {
        throw new ProjectArchivedError(projectId);
      }
      throw error;
    }
  },
});

/** Project基準のEvaluation/Execution/Orchestrationが読む参照だけを変換する。 */
export const projectDirectionRepositories = (projects: ProjectRepository, intents: IntentRepository, outcomes: OutcomeRepository): {
  intents: ProjectIntentReader; outcomes: ProjectOutcomeReader;
} => {
  const workspace = (projectId: string) => resolveProjectDirectionWorkspace(projects, projectId);
  return {
    intents: {
      findByProject: async id => intents.findByWorkspace(await workspace(id)),
      findById: async (id, intentId) => intents.findById(await workspace(id), intentId),
    },
    outcomes: {
      findByIntent: async (id, intentId) => outcomes.findByIntent(await workspace(id), intentId),
      findByIdInProject: async (id, outcomeId) => outcomes.findByIdInWorkspace(await workspace(id), outcomeId),
    },
  };
};

/** S03-04までのProject Context/Runtimeが使う読取だけを明示的に変換する。 */
export const projectResearchReader = (projects: ProjectRepository, research: import("@compass/direction").ResearchRepository) => ({
  findRequests: async (id: string, query?: import("@compass/direction").ResearchRequestQuery) => research.findRequests(await resolveProjectDirectionWorkspace(projects, id), query),
  findRequestDetail: async (id: string, requestId: string) => research.findRequestDetail(await resolveProjectDirectionWorkspace(projects, id), requestId),
  findIntentResearchSummary: async (id: string, intentId: string) => research.findIntentResearchSummary(await resolveProjectDirectionWorkspace(projects, id), intentId),
  findRelatedFindings: async (id: string, requestId: string, limit: number) => research.findRelatedFindings(await resolveProjectDirectionWorkspace(projects, id), requestId, limit),
});

export const projectDecisionReader = (projects: ProjectRepository, decisions: import("@compass/direction").DirectionDecisionRepository) => ({
  findByIntent: async (id: string, intentId: string) => decisions.findByIntent(await resolveProjectDirectionWorkspace(projects, id), intentId),
});

/** 認可は旧Project Grantを先に検査し、共有WorkspaceはContextへ渡さない。 */
export const projectDirectionContext = <Args extends unknown[], Result>(
  projects: ProjectRepository,
  authorization: import("@compass/direction").DirectionRoleAuthorizationPort,
  role: import("@compass/direction").DirectionAgentRole,
  context: { execute(principalId: string, workspaceId: string, ...args: Args): Promise<Result> },
) => ({ execute: async (principal: string | null, projectId: string, ...args: Args) => {
  const principalId = await authorization.requireRole(principal, projectId, role);
  const workspaceId = await resolveProjectDirectionWorkspace(projects, projectId);
  const result = await context.execute(principalId, workspaceId, ...args);
  return { ...result, project: await projects.findDetailById(projectId) };
} });
