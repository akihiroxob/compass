import type { OutcomeExecutionRecord } from "../domain/OutcomeExecution.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { NotFoundError } from "@compass/shared";

/**
 * Outcomeへ還流済みのExecutionの結果とEvidence参照を読む。ExecutionのStory・Taskは読まず、
 * Directionが保存した要約だけを返す（還流前のOutcomeは`null`）。認可は入口が行う
 * （Human向けWeb APIはGrantを要求せず、MCPはruntime Grantを要求する）。
 */
export class GetExecutionSummaryUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
  ) {}

  async execute(workspaceId: string, projectId: string, outcomeId: string): Promise<OutcomeExecutionRecord | null> {
    const project = await this.projectReader.findDetailById(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    if (!(await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId))) {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${projectId}`);
    }
    return this.outcomeExecutionRepository.find(workspaceId, projectId, outcomeId);
  }
}
