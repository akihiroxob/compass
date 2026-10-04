import type { Project } from "../domain/Project.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import { parseUpdateProjectInput } from "./projectSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { ProjectArchivedError } from "./error/ProjectArchivedError.ts";

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
