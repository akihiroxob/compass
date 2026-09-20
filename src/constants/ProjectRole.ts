/** Project scopeで割り当てるRole。追加時は型・入力検証・Instructionが追随する。 */
export const ProjectRole = {
  STRATEGIST: "strategist",
} as const;

export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const projectRoles = Object.values(ProjectRole) as [ProjectRole, ...ProjectRole[]];
