import type { ActivityTarget } from "../../domain/Activity.ts";

/**
 * 記録・取得の対象scope（ProjectまたはWorkspace。Organizationが所有）の状態。Activityはproject・workspaceのtableを直接読まない。
 */
export type ActivityScopeState = {
  /** Project scopeでは所属Workspace、Workspace scopeでは対象Workspace自身。 */
  workspaceId: string;
  /** Workspace scopeではnull。 */
  projectId: string | null;
  archived: boolean;
  /**
   * `project_resource`参照として受け付けるRepository・ResourceのID。Project scopeはそのProjectに登録済みのもの、
   * Workspace scopeは所属Project（archivedを含む）に登録済みのもの。
   */
  resourceIds: string[];
};

export interface ActivityScopeReader {
  /** 存在しないProject・Workspaceはnull。 */
  find(target: ActivityTarget): Promise<ActivityScopeState | null>;
}

/**
 * Agentの認可（Accessが所有）。serverがProjectはProject Role Grant、WorkspaceはWorkspace Role Grantで実装し、互いに継承しない。
 * activeRole（`X-Compass-Active-Role`）の指定時は、そのRoleのGrantだけで認可する。
 */
export interface ActivityAuthorizationPort {
  /** scopeのいずれかのGrant（activeRoleの指定時はそのRole）を要求し、Principalを返す。 */
  requireReader(principal: string | null, target: ActivityTarget): Promise<string>;
  /**
   * 記録するRoleを決める。`role`の指定時はscopeでのそのRoleのGrantを要求する。未指定ならactiveRoleを使い、
   * activeRoleも無ければ`null`（Roleを決められない）を返す。
   */
  resolveActor(principal: string | null, target: ActivityTarget, role: string | undefined): Promise<{ principalId: string; role: string } | null>;
}
