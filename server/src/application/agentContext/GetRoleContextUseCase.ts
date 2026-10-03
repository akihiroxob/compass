import type { Principal, ProjectAuthorizationService, ProjectRole } from "@compass/access";
import type { GetProjectUseCase } from "@compass/direction";
import type { AgentContextService } from "./AgentContextService.ts";

/** Role Contextへまだ接続していない入力。推測で埋めず、名前だけを示す。Activity summaryはTask 07で接続する。 */
export const unavailableRoleContextInputs = ["activity"] as const;

/**
 * Agent起動時のRole Context。Role Definition・適用Policy・Skill metadata・Project基本情報・Project Resourcesを返す。
 * Skill本文・Knowledge本文・Project文書の本文は含めず、必要時に`get_skill_context`や正本から取得させる。
 * Direction・Executionの集約（`get_strategist_context`等）は置き換えない。
 */
export class GetRoleContextUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly agentContext: AgentContextService,
    private readonly getProject: GetProjectUseCase,
  ) {}

  /** そのRoleのGrant（activeRoleの指定時は同じRoleに限る）を要求する。Grantの検査はProjectの存在確認より先に行う。 */
  async execute(principal: Principal, projectId: string, role: ProjectRole) {
    await this.authorization.requireRole(principal, projectId, role);
    const project = await this.getProject.execute(projectId);
    const assets = await this.agentContext.getRoleAssets(role);
    return {
      role: assets.role,
      policies: assets.policies,
      skills: assets.skills,
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        mission: project.mission,
        vision: project.vision,
        principles: project.principles,
        constraints: project.constraints,
        status: project.status,
      },
      resources: { repositories: project.repositories, resources: project.resources },
      unavailable: unavailableRoleContextInputs,
      source: assets.source,
    };
  }
}
