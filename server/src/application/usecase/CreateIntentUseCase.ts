import type { Intent } from "../../domain/model/Intent.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseCreateIntentInput } from "../../shared/intentSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

export class CreateIntentUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, input: unknown): Promise<Intent> {
    const parsed = parseCreateIntentInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
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
