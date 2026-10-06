import type { DirectionDecision } from "../domain/DirectionDecision.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { ProjectIntentReader } from "./port/ProjectDirectionReaders.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { NotFoundError } from "@compass/shared";

/** IntentのDirection Decisionを新しい順に返す読み取り専用のQuery。Human向け画面（Task 29）で使う。 */
export class ListDirectionDecisionsUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: ProjectIntentReader,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(projectId: string, intentId: string): Promise<DirectionDecision[]> {
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.intentRepository.findById(projectId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    return this.directionDecisionRepository.findByIntent(projectId, intentId);
  }
}
