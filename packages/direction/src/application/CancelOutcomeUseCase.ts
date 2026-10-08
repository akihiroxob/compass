import type { Outcome } from "../domain/Outcome.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseCancelOutcomeInput } from "./outcomeSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

export class CancelOutcomeUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    input: unknown,
  ): Promise<Outcome> {
    const { reason } = parseCancelOutcomeInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.outcomeRepository.cancel(workspaceId, intentId, outcomeId, reason);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "intent_not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    if (result.kind === "outcome_not_found") {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Intent ${intentId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Outcome ${outcomeId} is ${result.status} and cannot be cancelled`, {
        status: result.status,
      });
    }
    return result.outcome;
  }
}
