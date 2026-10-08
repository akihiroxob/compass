import type { Outcome } from "../domain/Outcome.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseCreateOutcomeInput } from "./outcomeSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

/** Strategist（またはHuman）の判断結果としてOutcomeと成功条件を登録する。Intentからの自動生成は行わない。 */
export class CreateOutcomeUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(workspaceId: string, intentId: string, input: unknown): Promise<Outcome> {
    const parsed = parseCreateOutcomeInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.outcomeRepository.create(workspaceId, intentId, parsed);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "intent_not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    if (result.kind === "intent_not_active") {
      throw new ConflictError(
        `Intent ${intentId} is ${result.status}; Outcomes can only be created under an active Intent`,
        { status: result.status },
      );
    }
    return result.outcome;
  }
}
