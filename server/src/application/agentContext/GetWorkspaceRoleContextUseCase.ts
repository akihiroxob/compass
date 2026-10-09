import type { Principal, RoleScopeAuthorizationService, WorkspaceRole } from "@compass/access";
import { recentActivitySummaryLimit, type ListActivitiesUseCase } from "@compass/activity";
import type { GetWorkspaceUseCase, ListWorkspaceProjectsUseCase } from "@compass/organization";
import type { AgentContextService } from "./AgentContextService.ts";
import { unavailableRoleContextInputs } from "./GetRoleContextUseCase.ts";

/**
 * Workspace Role（strategist / researcher / evaluator）の起動時のRole Context。Role Definition・適用Policy・Skill metadata・
 * Workspaceの戦略値（Mission / Vision / Principles / Constraints）・activeなProjectの要約・最近のWorkspace Activity summaryを返す。
 * Project要約はpurpose（`description`）とRepository・Resourceの参照だけで、ProjectのWork（Story / Task）・Project Activity・
 * Resourceの本文は含めない。Skill本文・Knowledge本文・Activity本文は`get_skill_context`・`get_workspace_activity`でJITに取得させる。
 * Direction集約（`get_strategist_context`等）は置き換えない。
 */
export class GetWorkspaceRoleContextUseCase {
  constructor(
    private readonly authorization: RoleScopeAuthorizationService,
    private readonly agentContext: AgentContextService,
    private readonly getWorkspace: GetWorkspaceUseCase,
    private readonly listWorkspaceProjects: ListWorkspaceProjectsUseCase,
    private readonly listWorkspaceActivities: ListActivitiesUseCase,
  ) {}

  /** WorkspaceのそのRoleのGrant（activeRoleの指定時は同じRoleに限る）を要求する。Grantの検査はWorkspaceの存在確認より先に行う。 */
  async execute(principal: Principal, workspaceId: string, role: WorkspaceRole) {
    await this.authorization.requireRole(principal, { kind: "workspace", id: workspaceId }, role);
    const workspace = await this.getWorkspace.execute(workspaceId);
    const projects = await this.listWorkspaceProjects.execute(workspaceId);
    const assets = await this.agentContext.getRoleAssets(role);
    const recent = await this.listWorkspaceActivities.execute(workspaceId, { limit: recentActivitySummaryLimit });
    return {
      role: assets.role,
      policies: assets.policies,
      skills: assets.skills,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        mission: workspace.mission,
        vision: workspace.vision,
        principles: workspace.principles,
        constraints: workspace.constraints,
        status: workspace.status,
      },
      // activeなProjectの要約（更新の新しい順）。本文は各参照の正本から取得する。
      projects: projects.map(({ id, name, description, status, repositories, resources }) => ({
        id,
        name,
        description,
        status,
        repositories,
        resources,
      })),
      // Workspace scopeだけの新しい順のsummaryとrefs。続きは`list_workspace_activities`の`beforeCursor`に`nextCursor`を渡して取得する。
      activity: recent,
      unavailable: unavailableRoleContextInputs,
      source: assets.source,
    };
  }
}
