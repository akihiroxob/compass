/**
 * Directionのuse caseが要求する認可。Role Grant・Runtime Credentialの規則はAccessが持ち、serverが実装を配線する。
 * 戻り値は認可済みのprincipalId（Evaluation・Evidence・ackの来歴に使う）。Projectの存在確認より先に呼ぶ。
 */

/** Bearerから解決した呼出し主体。Principalなしはnull。 */
export type Principal = string | null;

/** Directionのuse caseが要求するAgent Role。Role名と値はAccessのGrantと同じ。 */
export const DirectionAgentRole = {
  STRATEGIST: "strategist",
  RESEARCHER: "researcher",
  EVALUATOR: "evaluator",
} as const;

export type DirectionAgentRole = (typeof DirectionAgentRole)[keyof typeof DirectionAgentRole];

/** Directionの外部Runtime向け入口が要求するscope。値はAccessのRuntime Credential scopeと同じ。 */
export type DirectionRuntimeScope =
  | "runtime:event:read"
  | "runtime:event:ack"
  | "execution:evidence:write"
  | "runtime:state:read";

export interface DirectionRoleAuthorizationPort {
  requireRole(principal: Principal, projectId: string, role: DirectionAgentRole): Promise<string>;
}

/** `TCaller`はAccessが解決した呼出し（Agent名・Agent Credential・Runtime Credential）。Directionは中身を見ない。 */
export interface DirectionRuntimeAuthorizationPort<TCaller> {
  requireScope(caller: TCaller, projectId: string, scope: DirectionRuntimeScope): Promise<string>;
}
