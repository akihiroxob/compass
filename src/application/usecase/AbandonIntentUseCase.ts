import type { Intent } from "../../domain/model/Intent.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseAbandonIntentInput } from "../../shared/intentSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

export class AbandonIntentUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, intentId: string, input: unknown = {}): Promise<Intent> {
    const { reason } = parseAbandonIntentInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.intentRepository.abandon(projectId, intentId, reason);
    if (result.kind === "not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Intent ${intentId} is ${result.status} and cannot be abandoned`, {
        status: result.status,
      });
    }
    return result.intent;
  }
}
