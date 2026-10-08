import type { Workspace } from "../domain/Workspace.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";
import { parseUpdateWorkspaceInput } from "./workspaceSchema.ts";
import { NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "./error/WorkspaceArchivedError.ts";

export class UpdateWorkspaceUseCase {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  async execute(workspaceId: string, input: unknown): Promise<Workspace> {
    const result = await this.workspaceRepository.update(workspaceId, parseUpdateWorkspaceInput(input));
    if (result.kind === "not_found") throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    return result.workspace;
  }
}
