import type { DirectionDecision } from "../../domain/model/DirectionDecision.ts";
import type { DirectionDecisionRepository } from "../../domain/repository/DirectionDecisionRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { ResearchRepository } from "../../domain/repository/ResearchRepository.ts";
import { parseCreateDirectionDecisionInput } from "../../shared/directionDecisionSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { throwDirectionDecisionRejection } from "./directionDecisionRejection.ts";

/**
 * next_outcome以外の5種（additional_research / intent_complete / intent_abandon / policy_proposal / adr_candidate）の
 * Direction Decisionを記録する。判断時点のIntent Brief snapshotをResearchRepositoryから読み取って保存する
 * （snapshot読取とDecision書込は別transaction。Researcherの同時登録との厳密な一貫性は初期実装の対象外）。
 * policy_proposalはMission / Vision / Principles / Constraintsを直接変更しない（記録するだけ）。
 */
export class CreateDirectionDecisionUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(projectId: string, principalId: string, input: unknown): Promise<DirectionDecision> {
    const parsed = parseCreateDirectionDecisionInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const intentBriefSnapshot = await this.researchRepository.findIntentResearchSummary(projectId, parsed.intentId);
    const result = await this.directionDecisionRepository.create(projectId, intentBriefSnapshot, {
      ...parsed,
      principalId,
    });
    throwDirectionDecisionRejection(result, projectId, parsed.intentId);
    if (result.kind === "created" || result.kind === "replayed") return result.decision;
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
