import type { ProjectGrant } from "../../domain/model/ProjectGrant.ts";
import type { ProjectGrantRepository } from "../../domain/repository/ProjectGrantRepository.ts";
import type { ProjectRepository } from "@compass/direction";
import { NotFoundError } from "@compass/shared";

export class ListProjectGrantsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly projectGrantRepository: ProjectGrantRepository,
  ) {}

  async execute(projectId: string): Promise<ProjectGrant[]> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.projectGrantRepository.listByProject(projectId);
  }
}
