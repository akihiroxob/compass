import type { Outcome } from "../../domain/model/Outcome.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseCreateOutcomeInput } from "../../shared/outcomeSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

/** Strategist（またはHuman）の判断結果としてOutcomeと成功条件を登録する。Intentからの自動生成は行わない。 */
export class CreateOutcomeUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(projectId: string, intentId: string, input: unknown): Promise<Outcome> {
    const parsed = parseCreateOutcomeInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.outcomeRepository.create(projectId, intentId, parsed);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "intent_not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    if (result.kind === "intent_not_active") {
      throw new ConflictError(
        `Intent ${intentId} is ${result.status}; Outcomes can only be created under an active Intent`,
        { status: result.status },
      );
    }
    return result.outcome;
  }
}
