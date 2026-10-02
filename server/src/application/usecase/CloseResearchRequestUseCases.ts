import type { ResearchRequest } from "../../domain/model/Research.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type {
  CloseResearchRequestResult,
  ResearchRepository,
} from "../../domain/repository/ResearchRepository.ts";
import {
  parseCancelResearchRequestInput,
  parseCompleteResearchRequestInput,
} from "../../shared/researchSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { throwCommonResearchRejection } from "./researchRejection.ts";

const toClosedRequest = (result: CloseResearchRequestResult, projectId: string, requestId: string) => {
  throwCommonResearchRejection(result, projectId, requestId);
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
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, requestId: string, input: unknown): Promise<ResearchRequest> {
    const parsed = parseCompleteResearchRequestInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return toClosedRequest(await this.researchRepository.complete(projectId, requestId, parsed), projectId, requestId);
  }
}

export class CancelResearchRequestUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, requestId: string, input: unknown): Promise<ResearchRequest> {
    const { reason } = parseCancelResearchRequestInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return toClosedRequest(await this.researchRepository.cancel(projectId, requestId, reason), projectId, requestId);
  }
}
