import type { Workspace, WorkspaceStatus } from "../domain/Workspace.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";

export class ListWorkspacesUseCase {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  /** 既定はactiveのみ。archivedを見る場合は明示する。 */
  async execute(status: WorkspaceStatus = "active"): Promise<Workspace[]> {
    const workspaces = await this.workspaceRepository.findAll(status);
    return workspaces.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
