import type { ProjectGrantRepository, GrantResult } from "../../domain/repository/ProjectGrantRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseProjectGrantInput } from "../../shared/projectGrantSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

export class GrantProjectRoleUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly projectGrantRepository: ProjectGrantRepository,
  ) {}

  /** 入力検証はProjectの存在確認より先。再発行は`created: false`で副作用なし。 */
  async execute(projectId: string, input: unknown): Promise<GrantResult> {
    const { principalId, role } = parseProjectGrantInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.projectGrantRepository.grant(projectId, principalId, role);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "principal_bound_elsewhere") {
      throw new ConflictError(`Principal ${principalId} is bound to an Agent Credential of another Project`, {
        conflict: "PRINCIPAL_BOUND_ELSEWHERE",
      });
    }
    return { grant: result.grant, created: result.created };
  }
}
