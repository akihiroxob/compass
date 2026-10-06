import type { OutcomeEvaluation } from "../domain/OutcomeEvaluation.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { NotFoundError } from "@compass/shared";

/**
 * OutcomeのEvaluation履歴を新しい順に返す読取専用のQuery（Human向けOutcome詳細、Task 45）。
 * 登録はEvaluatorのMCP（`record_outcome_evaluation`）だけで行い、ここからは変更しない。
 */
export class ListOutcomeEvaluationsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
  ) {}

  async execute(workspaceId: string, outcomeId: string): Promise<OutcomeEvaluation[]> {
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    if (!(await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId))) {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    }
    return this.outcomeEvaluationRepository.findByOutcome(workspaceId, outcomeId);
  }
}
