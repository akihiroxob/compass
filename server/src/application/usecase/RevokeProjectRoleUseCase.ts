import type { ProjectGrantRepository } from "../../domain/repository/ProjectGrantRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseProjectGrantInput } from "../../shared/projectGrantSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

export class RevokeProjectRoleUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly projectGrantRepository: ProjectGrantRepository,
  ) {}

  /** 取り消したらtrue。存在しないGrantの取消はfalse（冪等）。 */
  async execute(projectId: string, input: unknown): Promise<boolean> {
    const { principalId, role } = parseProjectGrantInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.projectGrantRepository.revoke(projectId, principalId, role);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    return result.revoked;
  }
}
