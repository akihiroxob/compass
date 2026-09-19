import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseUpdateProjectInput } from "../../shared/projectSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

export class UpdateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, input: unknown): Promise<Project> {
    const project = await this.projectRepository.update(projectId, parseUpdateProjectInput(input));
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    return project;
  }
}
