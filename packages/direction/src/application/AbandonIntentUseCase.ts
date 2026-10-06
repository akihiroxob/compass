import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { parseAbandonIntentInput } from "./intentSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { ProjectArchivedError } from "@compass/organization";

export class AbandonIntentUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, intentId: string, input: unknown = {}): Promise<Intent> {
    const { reason } = parseAbandonIntentInput(input);
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.intentRepository.abandon(projectId, intentId, reason);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
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
