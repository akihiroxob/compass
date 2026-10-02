import type { ResearchRequestDetail } from "../domain/Research.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { NotFoundError } from "@compass/shared";

/** Requestと、Result → Finding / Evidence参照、Synthesisの来歴を返す。他ProjectのRequestは存在しないものとして扱う。 */
export class GetResearchRequestUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, requestId: string): Promise<ResearchRequestDetail> {
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const detail = await this.researchRepository.findRequestDetail(projectId, requestId);
    if (!detail) throw new NotFoundError(`Research Request ${requestId} was not found in Project ${projectId}`);
    return detail;
  }
}
