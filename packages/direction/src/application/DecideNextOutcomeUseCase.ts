import type { DirectionDecision } from "../domain/DirectionDecision.ts";
import type { Outcome } from "../domain/Outcome.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { parseDecideNextOutcomeInput } from "./directionDecisionSchema.ts";
import { NotFoundError } from "@compass/shared";
import { throwDirectionDecisionRejection } from "./directionDecisionRejection.ts";

/**
 * next_outcome判断とOutcome（固定のSuccess Criteriaを含む）を1 transactionで保存する（部分保存を許さない）。
 * Outcome入力の検証は既存のcreateOutcomeSchemaをそのまま使い、create_outcomeの固定Success Criteriaの規則を変えない。
 * 既存のcreate_outcome（Decisionを伴わない作成）は引き続き利用でき、そのOutcomeはoriginDecisionId無しで参照できる。
 */
export class DecideNextOutcomeUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly researchRepository: ResearchRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(
    projectId: string,
    principalId: string,
    input: unknown,
  ): Promise<{ decision: DirectionDecision; outcome: Outcome }> {
    const parsed = parseDecideNextOutcomeInput(input);
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const intentBriefSnapshot = await this.researchRepository.findIntentResearchSummary(projectId, parsed.intentId);
    const result = await this.directionDecisionRepository.decideNextOutcome(projectId, intentBriefSnapshot, {
      ...parsed,
      principalId,
    });
    throwDirectionDecisionRejection(result, projectId, parsed.intentId);
    if (result.kind === "created" || result.kind === "replayed") {
      return { decision: result.decision, outcome: result.outcome };
    }
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
