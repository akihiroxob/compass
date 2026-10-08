import { NotFoundError } from "@compass/shared";
import type { ProjectDetail } from "../domain/Project.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import { WorkspaceArchivedError } from "./error/WorkspaceArchivedError.ts";
import { parseCreateWorkspaceProjectInput } from "./projectSchema.ts";

/**
 * 既存のWorkspaceへProjectを作成する。Mission等はWorkspaceの正本を使い、入力から受け取らない。
 * `actor`を渡すと作成者をProjectのowner Membershipにする（WorkspaceのMembershipは変えない）。
 * 誰が作成できるかの認可はHuman向けの入口（AccessのWorkspace Membership）が行う。
 */
export class CreateWorkspaceProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(workspaceId: string, input: unknown, actor?: { humanUserId: string }): Promise<ProjectDetail> {
    const result = await this.projectRepository.createInWorkspace(
      workspaceId,
      parseCreateWorkspaceProjectInput(input),
      actor?.humanUserId,
    );
    if (result.kind === "not_found") throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    return result.project;
  }
}
