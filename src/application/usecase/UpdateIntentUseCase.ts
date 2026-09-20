import type { Intent } from "../../domain/model/Intent.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseUpdateIntentInput } from "../../shared/intentSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

export class UpdateIntentUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, intentId: string, input: unknown): Promise<Intent> {
    const parsed = parseUpdateIntentInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.intentRepository.update(projectId, intentId, parsed);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Intent ${intentId} is ${result.status} and can no longer be edited`, {
        status: result.status,
      });
    }
    if (result.kind === "meaning_locked") {
      throw new ConflictError(
        `Intent ${intentId} has Outcomes, so ${result.fields.join(" and ")} can no longer be changed; ` +
          "abandon the Intent and create a new one to change its meaning",
        { fixedFields: result.fields.join(",") },
      );
    }
    return result.intent;
  }
}
