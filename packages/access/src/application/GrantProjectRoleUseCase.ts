import type { ProjectGrantRepository, GrantResult } from "../domain/ProjectGrantRepository.ts";
import { ProjectArchivedError } from "@compass/organization";
import type { ProjectStateReader } from "./port/ProjectStateReader.ts";
import { parseProjectGrantInput } from "./projectGrantSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";

export class GrantProjectRoleUseCase {
  constructor(
    private readonly projects: ProjectStateReader,
    private readonly projectGrantRepository: ProjectGrantRepository,
  ) {}

  /** 入力検証はProjectの存在確認より先。再発行は`created: false`で副作用なし。 */
  async execute(projectId: string, input: unknown): Promise<GrantResult> {
    const { principalId, role } = parseProjectGrantInput(input);
    if (!(await this.projects.exists(projectId))) {
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
