/** Project scopeで割り当てるRole。追加時は型・入力検証・Instructionが追随する。 */
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
  /** 外部Runtimeがイベントを取得・ackするための暫定Role。Task 37でRuntime Credentialのscopeへ置き換える。 */
  RUNTIME: "runtime",
} as const;

export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const projectRoles = Object.values(ProjectRole) as [ProjectRole, ...ProjectRole[]];
