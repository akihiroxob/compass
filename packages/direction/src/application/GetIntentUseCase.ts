import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { NotFoundError } from "@compass/shared";

export class GetIntentUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(workspaceId: string, intentId: string): Promise<Intent> {
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const intent = await this.intentRepository.findById(workspaceId, intentId);
    if (!intent) throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    return intent;
  }
}
