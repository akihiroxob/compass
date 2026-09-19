import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";

export class ListProjectsUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(): Promise<Project[]> {
    const projects = await this.projectRepository.findAll();
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
