import type { Project, ProjectStatus } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";

export class ListProjectsUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  /** 既定はactiveのみ。archivedを見る場合は明示する。 */
  async execute(status: ProjectStatus = "active"): Promise<Project[]> {
    const projects = await this.projectRepository.findAll(status);
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
