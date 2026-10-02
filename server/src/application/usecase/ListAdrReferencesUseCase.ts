import type { AdrReference } from "../../domain/model/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../../domain/repository/AdrHandoffRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

/** ProjectのADR参照を新しい順に返す。Human向け画面（Task 29）や監査用途で使う読み取り専用のQuery。 */
export class ListAdrReferencesUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(projectId: string): Promise<AdrReference[]> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.adrHandoffRepository.findReferencesByProject(projectId);
  }
}
