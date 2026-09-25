import type { HumanActor } from "../../domain/model/HumanAuth.ts";
import type { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseCreateProjectInput } from "../../shared/projectSchema.ts";

export class CreateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  /**
   * `actor`を渡すと、作成者を同一transactionでowner Membershipにする（docs/step-6-human-auth-design.md）。
   * Web APIへのActorの受け渡しはTask 42で行い、それまでの呼出し（Web / MCP）はowner不在のProjectを作る。
   */
  async execute(input: unknown, actor?: HumanActor): Promise<Project> {
    return this.projectRepository.create(parseCreateProjectInput(input), actor?.humanUserId);
  }
}
