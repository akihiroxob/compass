import type { ResearchRequestDetail } from "../domain/Research.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { NotFoundError } from "@compass/shared";

/** Requestと、Result → Finding / Evidence参照、Synthesisの来歴を返す。他WorkspaceのRequestは存在しないものとして扱う。 */
export class GetResearchRequestUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(workspaceId: string, requestId: string): Promise<ResearchRequestDetail> {
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const detail = await this.researchRepository.findRequestDetail(workspaceId, requestId);
    if (!detail) throw new NotFoundError(`Research Request ${requestId} was not found in Workspace ${workspaceId}`);
    return detail;
  }
}
