import type { Outcome } from "../../domain/model/Outcome.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseCancelOutcomeInput } from "../../shared/outcomeSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

export class CancelOutcomeUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(
    projectId: string,
    intentId: string,
    outcomeId: string,
    input: unknown,
  ): Promise<Outcome> {
    const { reason } = parseCancelOutcomeInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.outcomeRepository.cancel(projectId, intentId, outcomeId, reason);
    if (result.kind === "intent_not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    if (result.kind === "outcome_not_found") {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Intent ${intentId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Outcome ${outcomeId} is ${result.status} and cannot be cancelled`, {
        status: result.status,
      });
    }
    return result.outcome;
  }
}
