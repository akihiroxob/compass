import type { AdrReference } from "../domain/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../domain/AdrHandoffRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { NotFoundError } from "@compass/shared";

/** ProjectのADR参照を新しい順に返す。Human向け画面（Task 29）や監査用途で使う読み取り専用のQuery。 */
export class ListAdrReferencesUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(projectId: string): Promise<AdrReference[]> {
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.adrHandoffRepository.findReferencesByProject(projectId);
  }
}
