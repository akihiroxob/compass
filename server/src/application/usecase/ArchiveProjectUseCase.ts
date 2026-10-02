import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseArchiveProjectInput } from "../../shared/projectSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

/**
 * Projectをactiveからarchivedへ遷移させる。復帰・削除は無く、子データ（Intent・Outcome・Grant）は変更しない。
 * Human向けのWeb API専用で、MCP tool・CLIコマンドへは公開しない。入力検証は存在確認より先。
 */
export class ArchiveProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, input: unknown): Promise<Project> {
    const { reason } = parseArchiveProjectInput(input);
    const result = await this.projectRepository.archive(projectId, reason);
    if (result.kind === "not_found") throw new NotFoundError(`Project ${projectId} was not found`);
    if (result.kind === "already_archived") {
      throw new ProjectArchivedError(projectId, `Project ${projectId} is already archived`);
    }
    return result.project;
  }
}
