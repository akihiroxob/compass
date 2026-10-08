import type { Project, ProjectStatus } from "../domain/Project.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";
import { NotFoundError } from "@compass/shared";

/**
 * Workspaceに所属するProjectの一覧（purpose・Repository・Resourceの参照）。Mission等はWorkspaceの正本を参照するため
 * Projectごとに複製しない。archivedのWorkspaceも参照できる（履歴の閲覧のため）。既定はactiveのProjectのみ。
 */
export class ListWorkspaceProjectsUseCase {
  constructor(
    private readonly workspaceRepository: WorkspaceRepository,
    private readonly projectRepository: ProjectRepository,
  ) {}

  async execute(workspaceId: string, status: ProjectStatus = "active"): Promise<Project[]> {
    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    const projects = await this.projectRepository.findAllInWorkspace(workspaceId, status);
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
