import type { ProjectDetail } from "../domain/Project.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import { parseCreateProjectInput } from "./projectSchema.ts";

export class CreateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  /**
   * Projectと専用のWorkspaceを作る。`actor`を渡すと、作成者を同一transactionでWorkspaceのowner Membershipにし、
   * そのMembershipでProjectも利用する（ADR 0003）。Actorの無い呼出し（MCP等）はowner不在のWorkspaceを作る。
   */
  async execute(input: unknown, actor?: { humanUserId: string }): Promise<ProjectDetail> {
    return this.projectRepository.create(parseCreateProjectInput(input), actor?.humanUserId);
  }
}
