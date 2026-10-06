import type { DirectionDecision } from "../domain/DirectionDecision.ts";
import type { ResearchRequest } from "../domain/Research.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { parseCreateDirectionDecisionInput } from "./directionDecisionSchema.ts";
import { NotFoundError } from "@compass/shared";
import { throwDirectionDecisionRejection } from "./directionDecisionRejection.ts";

/**
 * next_outcome以外の5種（additional_research / intent_complete / intent_abandon / policy_proposal / adr_candidate）の
 * Direction Decisionを記録する。判断時点のIntent Brief snapshotをResearchRepositoryから読み取って保存する
 * （snapshot読取とDecision書込は別transaction。Researcherの同時登録との厳密な一貫性は初期実装の対象外）。
 * policy_proposalはMission / Vision / Principles / Constraintsを直接変更しない（記録するだけ）。
 * additional_researchは、Strategistが決めた調査計画（`research`）から、追加Research Requestと`research_requested`イベントを
 * Decisionと同一transactionで作る。作られたRequestは`researchRequest`で返す（他のtypeではnull）。
 */
export class CreateDirectionDecisionUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
  ) {}

  async execute(
    workspaceId: string,
    principalId: string,
    input: unknown,
  ): Promise<{ decision: DirectionDecision; researchRequest: ResearchRequest | null }> {
    const parsed = parseCreateDirectionDecisionInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const intentBriefSnapshot = await this.researchRepository.findIntentResearchSummary(workspaceId, parsed.intentId);
    const result = await this.directionDecisionRepository.create(workspaceId, intentBriefSnapshot, {
      ...parsed,
      principalId,
    });
    throwDirectionDecisionRejection(result, workspaceId, parsed.intentId);
    if (result.kind === "created" || result.kind === "replayed") {
      return { decision: result.decision, researchRequest: result.researchRequest };
    }
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
