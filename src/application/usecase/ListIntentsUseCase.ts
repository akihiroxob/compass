import type { Intent } from "../../domain/model/Intent.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

export class ListIntentsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string): Promise<Intent[]> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.intentRepository.findByProject(projectId);
  }
}
