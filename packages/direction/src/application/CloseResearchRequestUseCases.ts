import type { ResearchRequest } from "../domain/Research.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type {
  CloseResearchRequestResult,
  ResearchRepository,
} from "../domain/ResearchRepository.ts";
import {
  parseCancelResearchRequestInput,
  parseCompleteResearchRequestInput,
} from "./researchSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { throwCommonResearchRejection } from "./researchRejection.ts";

const toClosedRequest = (result: CloseResearchRequestResult, workspaceId: string, requestId: string) => {
  throwCommonResearchRejection(result, workspaceId, requestId);
  if (result.kind === "incomplete") {
    throw new ConflictError(
      `Research Request ${requestId} cannot be completed without a ${result.missing}; close it as insufficient or not_needed instead`,
      { missing: result.missing },
    );
  }
  if (result.kind !== "closed") throw new Error(`Unexpected result: ${result.kind}`);
  return result.request;
};

/**
 * Requestをcompleted / insufficient / not_neededのいずれかで確定する。確定した状態がRuntimeの次の判断の根拠になる。
 * completedにはResultとSynthesisが必要で、insufficient / not_neededには停止理由が必要。
 */
export class CompleteResearchRequestUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(workspaceId: string, requestId: string, input: unknown): Promise<ResearchRequest> {
    const parsed = parseCompleteResearchRequestInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    return toClosedRequest(await this.researchRepository.complete(workspaceId, requestId, parsed), workspaceId, requestId);
  }
}

export class CancelResearchRequestUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(workspaceId: string, requestId: string, input: unknown): Promise<ResearchRequest> {
    const { reason } = parseCancelResearchRequestInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    return toClosedRequest(await this.researchRepository.cancel(workspaceId, requestId, reason), workspaceId, requestId);
  }
}
