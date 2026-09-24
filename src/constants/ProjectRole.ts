/** Project scopeで割り当てるRole。追加時は型・入力検証・Instructionが追随する。 */
export const ProjectRole = {
  STRATEGIST: "strategist",
  RESEARCHER: "researcher",
  /** 外部Runtimeがイベントを取得・ackするための暫定Role。Task 37でRuntime Credentialのscopeへ置き換える。 */
  RUNTIME: "runtime",
} as const;

export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const projectRoles = Object.values(ProjectRole) as [ProjectRole, ...ProjectRole[]];
