import type { ProjectRepository } from "@compass/organization";
import { NotFoundError } from "@compass/shared";

/** Projectが所属するWorkspace。Project固有の記録（Execution Summary / Evidence）の入口が、所有Workspaceを明示的に得るために使う。 */
export const projectWorkspaceId = async (projects: ProjectRepository, projectId: string): Promise<string> => {
  const project = await projects.findById(projectId);
  if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
  return project.workspaceId;
};
