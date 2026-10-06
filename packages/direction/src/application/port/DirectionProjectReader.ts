import type { ProjectDetail } from "@compass/organization";

/**
 * DirectionのUse Caseが読むProject（Organizationが所有）。存在・状態の確認と、Contextへ含める参照モデル
 * （Mission等は所属Workspaceの正本）。Organizationの`ProjectRepository`がこの形を満たし、serverが渡す。
 */
export interface DirectionProjectReader {
  exists(projectId: string): Promise<boolean>;
  findDetailById(projectId: string): Promise<ProjectDetail | null>;
}
