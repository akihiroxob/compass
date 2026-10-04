/** Activityが参照するProject（Directionが所有）の状態。Activityはprojectのtableを直接読まない。 */
export type ActivityProjectState = {
  archived: boolean;
  /** 登録済みのRepository・ResourceのID。`project_resource`参照の検証に使う。 */
  resourceIds: string[];
};

export interface ActivityProjectReader {
  /** 存在しないProjectはnull。 */
  find(projectId: string): Promise<ActivityProjectState | null>;
}

/**
 * Agentの認可（Accessが所有）。serverがProject Role Grantで実装する。
 * activeRole（`X-Compass-Active-Role`）の指定時は、そのRoleのGrantだけで認可する。
 */
export interface ActivityAuthorizationPort {
  /** ProjectのいずれかのGrant（activeRoleの指定時はそのRole）を要求し、Principalを返す。 */
  requireReader(principal: string | null, projectId: string): Promise<string>;
  /**
   * 記録するRoleを決める。`role`の指定時はそのRoleのGrantを要求する。未指定ならactiveRoleを使い、
   * activeRoleも無ければ`null`（Roleを決められない）を返す。
   */
  resolveActor(principal: string | null, projectId: string, role: string | undefined): Promise<{ principalId: string; role: string } | null>;
}
