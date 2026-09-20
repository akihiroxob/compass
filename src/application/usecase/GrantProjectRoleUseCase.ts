import type { ProjectGrantRepository, GrantResult } from "../../domain/repository/ProjectGrantRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseProjectGrantInput } from "../../shared/projectGrantSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

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
    return this.projectGrantRepository.grant(projectId, principalId, role);
  }
}
