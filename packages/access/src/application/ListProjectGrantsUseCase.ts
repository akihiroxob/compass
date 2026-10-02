import type { ProjectGrant } from "../domain/ProjectGrant.ts";
import type { ProjectGrantRepository } from "../domain/ProjectGrantRepository.ts";
import type { ProjectStateReader } from "./port/ProjectStateReader.ts";
import { NotFoundError } from "@compass/shared";

export class ListProjectGrantsUseCase {
  constructor(
    private readonly projects: ProjectStateReader,
    private readonly projectGrantRepository: ProjectGrantRepository,
  ) {}

  async execute(projectId: string): Promise<ProjectGrant[]> {
    if (!(await this.projects.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.projectGrantRepository.listByProject(projectId);
  }
}
