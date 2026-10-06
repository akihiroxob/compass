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

/** Project基準のResearch/Decision/Evaluation/Execution Contextが読む参照だけを変換する。 */
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
