import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseAbandonIntentInput } from "./intentSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { versionConflict } from "./intentVersionConflict.ts";
import { WorkspaceArchivedError } from "@compass/organization";

export class AbandonIntentUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(workspaceId: string, intentId: string, input: unknown = {}): Promise<Intent> {
    const { reason, expectedVersion } = parseAbandonIntentInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.intentRepository.abandon(workspaceId, intentId, reason, expectedVersion);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Intent ${intentId} is ${result.status} and cannot be abandoned`, {
        status: result.status,
      });
    }
    if (result.kind === "version_conflict") throw versionConflict(intentId, result.currentVersion);
    return result.intent;
  }
}
