import type { ProjectDetail } from "../domain/Project.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import { NotFoundError } from "@compass/shared";

export class GetProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string): Promise<ProjectDetail> {
    const project = await this.projectRepository.findDetailById(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    return project;
  }
}
