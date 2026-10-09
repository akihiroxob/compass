import type { Principal, ProjectAuthorizationService, ProjectRole } from "@compass/access";
import { recentActivitySummaryLimit, type ListActivitiesUseCase } from "@compass/activity";
import type { ListProjectTargetOutcomesUseCase } from "@compass/direction";
import type { GetProjectUseCase, GetWorkspaceUseCase } from "@compass/organization";
import type { AgentContextService } from "./AgentContextService.ts";

/** Role Contextへまだ接続していない入力。推測で埋めず、名前だけを示す。現在はすべて接続済み。 */
export const unavailableRoleContextInputs = [] as const;

/**
 * Project Role（manager / worker / reviewer）の起動時のRole Context。Role Definition・適用Policy・Skill metadata・
 * Project基本情報・Project Resources・所属Workspaceの要約・このProjectをTargetとするactiveなOutcome・最近のProject Activity
 * summaryを返す。Workspaceは所属Workspaceだけを読み、他Project・Workspace Activity・Story / Taskは含めない。
 * Skill本文・Knowledge本文・Project文書・Activityの本文は含めず、必要時に`get_skill_context`・`get_activity`や正本から取得させる。
 * Direction・Executionの集約（`get_strategist_context`・`get_outcome_handoff_context`等）は置き換えない。
 */
export class GetRoleContextUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly agentContext: AgentContextService,
    private readonly getProject: GetProjectUseCase,
    private readonly getWorkspace: GetWorkspaceUseCase,
    private readonly listTargetOutcomes: ListProjectTargetOutcomesUseCase,
    private readonly listActivities: ListActivitiesUseCase,
  ) {}

  /** そのRoleのGrant（activeRoleの指定時は同じRoleに限る）を要求する。Grantの検査はProjectの存在確認より先に行う。 */
  async execute(principal: Principal, projectId: string, role: ProjectRole) {
    await this.authorization.requireRole(principal, projectId, role);
    const project = await this.getProject.execute(projectId);
    const workspace = await this.getWorkspace.execute(project.workspaceId);
    const outcomes = await this.listTargetOutcomes.execute(project.workspaceId, projectId);
    const assets = await this.agentContext.getRoleAssets(role);
    const recent = await this.listActivities.execute(projectId, { limit: recentActivitySummaryLimit });
    return {
      role: assets.role,
      policies: assets.policies,
      skills: assets.skills,
      project: {
        id: project.id,
        workspaceId: project.workspaceId,
        name: project.name,
        description: project.description,
        status: project.status,
      },
      resources: { repositories: project.repositories, resources: project.resources },
      // 所属Workspaceの戦略値（正本はWorkspace）。Workspaceの他Project・Activityは含めない。
      workspace: {
        id: workspace.id,
        name: workspace.name,
        mission: workspace.mission,
        vision: workspace.vision,
        principles: workspace.principles,
        constraints: workspace.constraints,
        status: workspace.status,
      },
      // このProjectが担当する（Targetの）activeなOutcome。Storyは`correlationId`で`list_stories`から探す。
      outcomes,
      // Project scopeだけの新しい順のsummaryとrefsだけ。続きは`list_activities`の`beforeCursor`に`nextCursor`を渡して取得する。
      activity: recent,
      unavailable: unavailableRoleContextInputs,
      source: assets.source,
    };
  }
}
