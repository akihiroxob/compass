import type { ResearchRequest } from "../../domain/model/Research.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { ResearchRepository } from "../../domain/repository/ResearchRepository.ts";
import { parseCreateResearchRequestInput } from "../../shared/researchSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";
import { ValidationError } from "../error/ValidationError.ts";

/**
 * Intentを発端にResearch Requestを登録する。同じrequestKeyの再送は既存のRequestを返し、重複を作らない。
 * Agentの起動やschedulingは行わない（Runtimeの責務）。
 */
export class CreateResearchRequestUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, input: unknown): Promise<ResearchRequest> {
    const parsed = parseCreateResearchRequestInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.researchRepository.createRequest(projectId, parsed);
    switch (result.kind) {
      case "created":
      case "replayed":
        return result.request;
      case "project_archived":
        throw new ProjectArchivedError(projectId);
      case "intent_not_found":
        throw new NotFoundError(`Intent ${parsed.originIntentId} was not found in Project ${projectId}`);
      case "outcome_not_found":
        throw new NotFoundError(
          `Outcome ${parsed.originOutcomeId} was not found in Intent ${parsed.originIntentId}`,
        );
      case "intent_not_active":
        throw new ConflictError(
          `Intent ${parsed.originIntentId} is ${result.status}; Research Requests can only be created for an active Intent`,
          { status: result.status },
        );
      case "deadline_in_past":
        throw new ValidationError("Research Request input is invalid", [
          { path: "deadlineAt", message: "deadlineAt must be in the future" },
        ]);
      case "key_conflict":
        throw new ConflictError(`requestKey ${result.requestKey} was already used with different content`, {
          requestKey: result.requestKey,
        });
    }
  }
}
