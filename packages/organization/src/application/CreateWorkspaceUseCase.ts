import type { Workspace } from "../domain/Workspace.ts";
import type { WorkspaceRepository } from "../domain/WorkspaceRepository.ts";
import { parseCreateWorkspaceInput } from "./workspaceSchema.ts";

export class CreateWorkspaceUseCase {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  async execute(input: unknown): Promise<Workspace> {
    return this.workspaceRepository.create(parseCreateWorkspaceInput(input));
  }
}
