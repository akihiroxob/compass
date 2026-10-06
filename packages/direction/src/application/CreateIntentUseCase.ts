import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { parseCreateIntentInput } from "./intentSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { ProjectArchivedError } from "@compass/organization";

export class CreateIntentUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, input: unknown): Promise<Intent> {
    const parsed = parseCreateIntentInput(input);
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.intentRepository.create(projectId, parsed);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "active_exists") {
      throw new ConflictError(
        `Project ${projectId} already has an active Intent ${result.activeIntentId}; abandon it before creating another`,
        { activeIntentId: result.activeIntentId },
      );
    }
    return result.intent;
  }
}
