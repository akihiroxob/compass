import type { IntentRepository, OutcomeRepository, ProjectIntentReader, ProjectOutcomeReader } from "@compass/direction";
import type { ProjectRepository } from "@compass/organization";
import { ConflictError, NotFoundError } from "@compass/shared";

/** Projectが所属するWorkspace。Project固有の記録（Execution Summary / Evidence）の入口が、所有Workspaceを明示的に得るために使う。 */
export const projectWorkspaceId = async (projects: ProjectRepository, projectId: string): Promise<string> => {
  const project = await projects.findById(projectId);
  if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
  return project.workspaceId;
};

/**
 * Workspace単位へ切り替える前のProject基準の読取（Orchestration State・Story handoffの参照）。Workspace IDをProject IDと解釈せず、
 * Organizationで所属を解決する。複数Projectが共有するWorkspaceのDirectionはProject単位で扱えないため拒否する（S04-03・S08-01で切替）。
 */
export const resolveProjectDirectionWorkspace = async (projects: ProjectRepository, projectId: string): Promise<string> => {
  const workspaceId = await projectWorkspaceId(projects, projectId);
  const siblings = [...await projects.findAllInWorkspace(workspaceId), ...await projects.findAllInWorkspace(workspaceId, "archived")];
  if (siblings.length !== 1) {
    throw new ConflictError("Workspace Direction requires the Workspace entry point", { reason: "workspace_direction_required" });
  }
  return workspaceId;
};

/** Project基準のWork/Orchestrationが読む参照だけを変換する。 */
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

/** Orchestration Stateが使う読取だけを明示的に変換する。 */
export const projectResearchReader = (projects: ProjectRepository, research: import("@compass/direction").ResearchRepository) => ({
  findRequests: async (id: string, query?: import("@compass/direction").ResearchRequestQuery) => research.findRequests(await resolveProjectDirectionWorkspace(projects, id), query),
  findRequestDetail: async (id: string, requestId: string) => research.findRequestDetail(await resolveProjectDirectionWorkspace(projects, id), requestId),
  findIntentResearchSummary: async (id: string, intentId: string) => research.findIntentResearchSummary(await resolveProjectDirectionWorkspace(projects, id), intentId),
  findRelatedFindings: async (id: string, requestId: string, limit: number) => research.findRelatedFindings(await resolveProjectDirectionWorkspace(projects, id), requestId, limit),
});

export const projectDecisionReader = (projects: ProjectRepository, decisions: import("@compass/direction").DirectionDecisionRepository) => ({
  findByIntent: async (id: string, intentId: string) => decisions.findByIntent(await resolveProjectDirectionWorkspace(projects, id), intentId),
});
