import type { OutcomeExecutionRecord } from "../domain/OutcomeExecution.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import { NotFoundError } from "@compass/shared";

/**
 * Outcomeへ還流済みのExecutionの結果とEvidence参照を読む。ExecutionのStory・Taskは読まず、
 * Directionが保存した要約だけを返す（還流前のOutcomeは`null`）。認可は入口が行う
 * （Human向けWeb APIはGrantを要求せず、MCPはruntime Grantを要求する）。
 */
export class GetExecutionSummaryUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
  ) {}

  async execute(projectId: string, outcomeId: string): Promise<OutcomeExecutionRecord | null> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.outcomeRepository.findByIdInProject(projectId, outcomeId))) {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${projectId}`);
    }
    return this.outcomeExecutionRepository.find(projectId, outcomeId);
  }
}
