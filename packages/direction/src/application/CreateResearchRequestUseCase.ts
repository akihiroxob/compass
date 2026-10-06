import type { ResearchRequest } from "../domain/Research.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { parseCreateResearchRequestInput } from "./researchSchema.ts";
import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

/**
 * Intentを発端にResearch Requestを登録する。同じrequestKeyの再送は既存のRequestを返し、重複を作らない。
 * Agentの起動やschedulingは行わない（Runtimeの責務）。
 */
export class CreateResearchRequestUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(workspaceId: string, input: unknown): Promise<ResearchRequest> {
    const parsed = parseCreateResearchRequestInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.researchRepository.createRequest(workspaceId, parsed);
    switch (result.kind) {
      case "created":
      case "replayed":
        return result.request;
      case "workspace_archived":
        throw new WorkspaceArchivedError(workspaceId);
      case "intent_not_found":
        throw new NotFoundError(`Intent ${parsed.originIntentId} was not found in Workspace ${workspaceId}`);
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
