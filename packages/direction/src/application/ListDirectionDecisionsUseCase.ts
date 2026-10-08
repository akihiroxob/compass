import type { DirectionDecision } from "../domain/DirectionDecision.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { NotFoundError } from "@compass/shared";

/** IntentのDirection Decisionを新しい順に返す読み取り専用のQuery。Human向け画面（Task 29）で使う。 */
export class ListDirectionDecisionsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(workspaceId: string, intentId: string): Promise<DirectionDecision[]> {
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    if (!(await this.intentRepository.findById(workspaceId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    return this.directionDecisionRepository.findByIntent(workspaceId, intentId);
  }
}
