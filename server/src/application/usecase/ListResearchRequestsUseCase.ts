import type { ResearchRequest } from "../../domain/model/Research.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { ResearchRepository } from "../../domain/repository/ResearchRepository.ts";
import { parseResearchRequestFilter } from "../../shared/researchSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";

/** ProjectのResearch Requestを新しい順で返す。発端Intentや状態で絞り込める。 */
export class ListResearchRequestsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, filter: unknown = {}): Promise<ResearchRequest[]> {
    const query = parseResearchRequestFilter(filter);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.researchRepository.findRequests(projectId, query);
  }
}
