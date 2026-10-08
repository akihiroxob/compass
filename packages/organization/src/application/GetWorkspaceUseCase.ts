import type { Workspace } from "../domain/Workspace.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";
import { NotFoundError } from "@compass/shared";

/** archivedのWorkspaceも参照できる（履歴の閲覧のため）。 */
export class GetWorkspaceUseCase {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  async execute(workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    return workspace;
  }
}
