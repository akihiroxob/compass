import type { DirectionDecision } from "../domain/DirectionDecision.ts";
import type { Outcome } from "../domain/Outcome.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
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
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(
    workspaceId: string,
    principalId: string,
    input: unknown,
  ): Promise<{ decision: DirectionDecision; outcome: Outcome }> {
    const parsed = parseDecideNextOutcomeInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const intentBriefSnapshot = await this.researchRepository.findIntentResearchSummary(workspaceId, parsed.intentId);
    const result = await this.directionDecisionRepository.decideNextOutcome(workspaceId, intentBriefSnapshot, {
      ...parsed,
      principalId,
    });
    throwDirectionDecisionRejection(result, workspaceId, parsed.intentId);
    if (result.kind === "created" || result.kind === "replayed") {
      return { decision: result.decision, outcome: result.outcome };
    }
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
