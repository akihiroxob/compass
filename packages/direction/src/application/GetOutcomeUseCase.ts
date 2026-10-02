import type { Outcome } from "../domain/Outcome.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import { NotFoundError } from "@compass/shared";

export class GetOutcomeUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(projectId: string, intentId: string, outcomeId: string): Promise<Outcome> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.intentRepository.findById(projectId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    const outcome = await this.outcomeRepository.findById(projectId, intentId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Intent ${intentId}`);
    return outcome;
  }
}
