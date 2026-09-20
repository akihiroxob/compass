import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseUpdateProjectInput } from "../../shared/projectSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

export class UpdateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, input: unknown): Promise<Project> {
    const result = await this.projectRepository.update(projectId, parseUpdateProjectInput(input));
    if (result.kind === "not_found") throw new NotFoundError(`Project ${projectId} was not found`);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    return result.project;
  }
}
