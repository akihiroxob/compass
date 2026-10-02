import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseUpdateProjectInput } from "../../shared/projectSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

export class UpdateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, input: unknown): Promise<Project> {
    const result = await this.projectRepository.update(projectId, parseUpdateProjectInput(input));
    if (result.kind === "not_found") throw new NotFoundError(`Project ${projectId} was not found`);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "repository_referenced") {
      throw new ConflictError(
        `Repository ${result.repositoryName} is referenced by an ADR handoff request or reference and cannot be removed`,
        { repositoryId: result.repositoryId, repositoryName: result.repositoryName },
      );
    }
    return result.project;
  }
}
