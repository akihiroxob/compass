import type { Workspace } from "../domain/Workspace.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";
import { parseArchiveWorkspaceInput } from "./workspaceSchema.ts";
import { NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "./error/WorkspaceArchivedError.ts";

/**
 * Workspaceをactiveからarchivedへ遷移させる。復帰・削除は無い。入力検証は存在確認より先。
 * 所属Project・Directionへの新規活動の拒否は、それらをWorkspaceへ関連付けるTaskで同じ状態を検査する。
 */
export class ArchiveWorkspaceUseCase {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  async execute(workspaceId: string, input: unknown): Promise<Workspace> {
    const { reason } = parseArchiveWorkspaceInput(input);
    const result = await this.workspaceRepository.archive(workspaceId, reason);
    if (result.kind === "not_found") throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    if (result.kind === "already_archived") {
      throw new WorkspaceArchivedError(workspaceId, `Workspace ${workspaceId} is already archived`);
    }
    return result.workspace;
  }
}
