import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { DirectionActorPort } from "./port/DirectionActorPort.ts";
import { parseCreateIntentInput } from "./intentSchema.ts";
import { NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

export class CreateIntentUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly actor: DirectionActorPort,
  ) {}

  async execute(workspaceId: string, input: unknown): Promise<Intent> {
    const parsed = parseCreateIntentInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.intentRepository.create(workspaceId, parsed, this.actor.current());
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    return result.intent;
  }
}
