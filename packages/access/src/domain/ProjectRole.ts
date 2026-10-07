/** Agent Role識別子。既存Project入口の型名を維持し、明示scopeの許可RoleはRoleScopeが定義する。 */
export const ProjectRole = {
  STRATEGIST: "strategist",
  RESEARCHER: "researcher",
  /** Execution（Story / Taskの管理）。Story・Taskの作成・編集・取消と最終受入を担う。 */
  MANAGER: "manager",
  /** Executionでの実装。Taskをclaimして作業し、レビュー可能な状態へ進める。 */
  WORKER: "worker",
  /** Executionでの実装レビュー。 */
  REVIEWER: "reviewer",
  /** Outcomeの固定Success Criteriaを、Execution Evidenceの観測結果で判定する。Outcome定義・Execution結果は変更できない。 */
  EVALUATOR: "evaluator",
  /** trusted-localのAgent名Bearerで外部Runtimeの入口を使うための開発用Role。remote modeではRuntime Credentialのscopeで認可する（Task 37）。 */
  RUNTIME: "runtime",
} as const;

export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const projectRoles = Object.values(ProjectRole) as [ProjectRole, ...ProjectRole[]];
