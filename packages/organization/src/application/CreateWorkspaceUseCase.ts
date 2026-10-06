import type { Workspace } from "../domain/Workspace.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";
import { parseCreateWorkspaceInput } from "./workspaceSchema.ts";

export class CreateWorkspaceUseCase {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  /** `actor`を渡すと、作成者を同一transactionでWorkspaceのowner Membershipにする。 */
  async execute(input: unknown, actor?: { humanUserId: string }): Promise<Workspace> {
    return this.workspaceRepository.create(parseCreateWorkspaceInput(input), actor?.humanUserId);
  }
}
