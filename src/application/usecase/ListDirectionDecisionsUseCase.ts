import type { DirectionDecision } from "../../domain/model/DirectionDecision.ts";
import type { DirectionDecisionRepository } from "../../domain/repository/DirectionDecisionRepository.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

/** IntentのDirection Decisionを新しい順に返す読み取り専用のQuery。Human向け画面（Task 29）で使う。 */
export class ListDirectionDecisionsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(projectId: string, intentId: string): Promise<DirectionDecision[]> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.intentRepository.findById(projectId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    }
    return this.directionDecisionRepository.findByIntent(projectId, intentId);
  }
}
