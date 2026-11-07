import type { IntentRevision } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { NotFoundError } from "@compass/shared";

/** Intentの版の履歴（新しい順）。Outcome・判断・評価が持つ`intentVersion`の内容をここで参照する。 */
export class ListIntentRevisionsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(workspaceId: string, intentId: string): Promise<IntentRevision[]> {
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const revisions = await this.intentRepository.findRevisions(workspaceId, intentId);
    if (!revisions) throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    return revisions;
  }
}
