import type { Outcome } from "../../domain/model/Outcome.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseUpdateOutcomeInput } from "../../shared/outcomeSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

/**
 * activeなOutcomeのtitleとhypothesisだけを更新する。
 * 成功条件・description・rationaleは作成時に固定され、入力に含まれた場合は黙って無視せず拒否する。
 */
export class UpdateOutcomeUseCase {
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
    const { changes, fixedFields } = parseUpdateOutcomeInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (fixedFields.length > 0) {
      throw new ConflictError(
        `Outcome ${outcomeId} has fields fixed at creation (${fixedFields.join(", ")}) that cannot be changed; ` +
          "cancel the Outcome and create a new one instead",
        { fixedFields: fixedFields.join(",") },
      );
    }
    const result = await this.outcomeRepository.update(projectId, intentId, outcomeId, changes);
    if (result.kind === "intent_not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    if (result.kind === "outcome_not_found") {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Intent ${intentId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Outcome ${outcomeId} is ${result.status} and can no longer be edited`, {
        status: result.status,
      });
    }
    return result.outcome;
  }
}
