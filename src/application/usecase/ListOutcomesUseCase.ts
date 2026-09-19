import type { Outcome } from "../../domain/model/Outcome.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

export class ListOutcomesUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(projectId: string, intentId: string): Promise<Outcome[]> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.intentRepository.findById(projectId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    return this.outcomeRepository.findByIntent(projectId, intentId);
  }
}
