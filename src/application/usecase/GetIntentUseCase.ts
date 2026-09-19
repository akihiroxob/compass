import type { Intent } from "../../domain/model/Intent.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

export class GetIntentUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, intentId: string): Promise<Intent> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const intent = await this.intentRepository.findById(projectId, intentId);
    if (!intent) throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    return intent;
  }
}
