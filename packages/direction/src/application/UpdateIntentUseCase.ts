import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseUpdateIntentInput } from "./intentSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

export class UpdateIntentUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(workspaceId: string, intentId: string, input: unknown): Promise<Intent> {
    const parsed = parseUpdateIntentInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.intentRepository.update(workspaceId, intentId, parsed);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
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
