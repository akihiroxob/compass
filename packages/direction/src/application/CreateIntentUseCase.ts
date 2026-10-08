import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseCreateIntentInput } from "./intentSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

export class CreateIntentUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(workspaceId: string, input: unknown): Promise<Intent> {
    const parsed = parseCreateIntentInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.intentRepository.create(workspaceId, parsed);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "active_exists") {
      throw new ConflictError(
        `Workspace ${workspaceId} already has an active Intent ${result.activeIntentId}; abandon it before creating another`,
        { activeIntentId: result.activeIntentId },
      );
    }
    return result.intent;
  }
}
