import type { Outcome } from "../domain/Outcome.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { NotFoundError } from "@compass/shared";

export class ListOutcomesUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(projectId: string, intentId: string): Promise<Outcome[]> {
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.intentRepository.findById(projectId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    return this.outcomeRepository.findByIntent(projectId, intentId);
  }
}
