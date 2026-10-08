import type { Workspace } from "@compass/organization";

/** Organizationが所有するWorkspaceの存在・状態。公開入口の認可はAccessが担当する。 */
export interface DirectionWorkspaceReader {
  findById(workspaceId: string): Promise<Workspace | null>;
}
