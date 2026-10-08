import type { ProjectGrantRepository } from "../domain/ProjectGrantRepository.ts";
import { ProjectArchivedError } from "@compass/organization";
import type { ProjectStateReader } from "./port/ProjectStateReader.ts";
import { parseProjectGrantInput } from "./projectGrantSchema.ts";
import { NotFoundError } from "@compass/shared";

export class RevokeProjectRoleUseCase {
  constructor(
    private readonly projects: ProjectStateReader,
    private readonly projectGrantRepository: ProjectGrantRepository,
  ) {}

  /** 取り消したらtrue。存在しないGrantの取消はfalse（冪等）。 */
  async execute(projectId: string, input: unknown): Promise<boolean> {
    const { principalId, role } = parseProjectGrantInput(input);
    if (!(await this.projects.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.projectGrantRepository.revoke(projectId, principalId, role);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    return result.revoked;
  }
}
