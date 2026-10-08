import type { AdrReference } from "../domain/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../domain/AdrHandoffRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { NotFoundError } from "@compass/shared";

/** WorkspaceのADR参照を新しい順に返す。Human向け画面（Task 29）や監査用途で使う読み取り専用のQuery。 */
export class ListAdrReferencesUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(workspaceId: string): Promise<AdrReference[]> {
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    return this.adrHandoffRepository.findReferencesByWorkspace(workspaceId);
  }
}
