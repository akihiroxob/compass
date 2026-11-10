import { type DirectionProjectReaders, type DirectionWorkspaceReaders } from "@compass/direction";
import { findProjectRepository, findProjectWorkspaceId, findProjectWorkspaceConstraints, isProjectArchived, findArchivedProjectIds, isWorkspaceArchived } from "@compass/organization";
import { asOrganizationDatabase } from "../database/contextDatabase.ts";

/** DirectionがIntent・Outcome等の書込と同じtransactionで読む、Project状態・Repository・所属WorkspaceのConstraints（Organization）。 */
export const directionProjectReaders: DirectionProjectReaders = (executor) => {
  const database = asOrganizationDatabase(executor);
  return {
    isArchived: (projectId) => isProjectArchived(database, projectId),
    findArchivedIds: (projectIds) => findArchivedProjectIds(database, projectIds),
    findRepository: (projectId, repositoryId) => findProjectRepository(database, projectId, repositoryId),
    findConstraints: (projectId) => findProjectWorkspaceConstraints(database, projectId),
    findWorkspaceId: (projectId) => findProjectWorkspaceId(database, projectId),
  };
};

/** Intent/Outcomeが直接読むWorkspaceの状態。Projectを経由しない。 */
export const directionWorkspaceReaders: DirectionWorkspaceReaders = (executor) => ({
  resourceBelongsToWorkspace: async (workspaceId, resourceId) => {
    const row = await asOrganizationDatabase(executor).selectFrom("project_resource")
      .innerJoin("project", "project.id", "project_resource.project_id")
      .select("project_resource.id").where("project_resource.id", "=", resourceId)
      .where("project.workspace_id", "=", workspaceId).executeTakeFirst();
    return row !== undefined;
  },
  isArchived: (workspaceId) => isWorkspaceArchived(asOrganizationDatabase(executor), workspaceId),
});
