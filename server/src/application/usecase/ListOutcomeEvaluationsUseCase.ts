import type { OutcomeEvaluation } from "../../domain/model/OutcomeEvaluation.ts";
import type { OutcomeEvaluationRepository } from "../../domain/repository/OutcomeEvaluationRepository.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

/**
 * OutcomeのEvaluation履歴を新しい順に返す読取専用のQuery（Human向けOutcome詳細、Task 45）。
 * 登録はEvaluatorのMCP（`record_outcome_evaluation`）だけで行い、ここからは変更しない。
 */
export class ListOutcomeEvaluationsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
  ) {}

  async execute(projectId: string, outcomeId: string): Promise<OutcomeEvaluation[]> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.outcomeRepository.findByIdInProject(projectId, outcomeId))) {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${projectId}`);
    }
    return this.outcomeEvaluationRepository.findByOutcome(projectId, outcomeId);
  }
}
