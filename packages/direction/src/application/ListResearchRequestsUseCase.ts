import type { ResearchRequest } from "../domain/Research.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { parseResearchRequestFilter } from "./researchSchema.ts";
import { NotFoundError } from "@compass/shared";

/** WorkspaceのResearch Requestを新しい順で返す。発端Intentや状態で絞り込める。 */
export class ListResearchRequestsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(workspaceId: string, filter: unknown = {}): Promise<ResearchRequest[]> {
    const query = parseResearchRequestFilter(filter);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    return this.researchRepository.findRequests(workspaceId, query);
  }
}
