import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseCreateProjectInput } from "../../shared/projectSchema.ts";

export class CreateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(input: unknown): Promise<Project> {
    return this.projectRepository.create(parseCreateProjectInput(input));
  }
}
