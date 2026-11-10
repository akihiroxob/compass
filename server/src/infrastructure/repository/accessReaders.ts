import { type AccessProjectReaders, type AccessWorkspaceReaders } from "@compass/access";
import { findProjectWorkspaceId, isProjectArchived, isWorkspaceArchived, listWorkspaceIdsInCreationOrder, listWorkspaceProjectIds, projectExists } from "@compass/organization";
import { asOrganizationDatabase } from "../database/contextDatabase.ts";

/** AccessがGrant・Credential・招待の書込と同じtransactionで読む、Project状態と所属Workspace（Organization）。 */
export const accessProjectReaders: AccessProjectReaders = (executor) => {
  const database = asOrganizationDatabase(executor);
  return {
    exists: (projectId) => projectExists(database, projectId),
    isArchived: (projectId) => isProjectArchived(database, projectId),
    findWorkspaceId: (projectId) => findProjectWorkspaceId(database, projectId),
  };
};

/** AccessがWorkspace Membershipの書込・初期Membershipの補完と同じtransactionで読む、Workspace状態（Organization）。 */
export const accessWorkspaceReaders: AccessWorkspaceReaders = (executor) => {
  const database = asOrganizationDatabase(executor);
  return {
    isArchived: (workspaceId) => isWorkspaceArchived(database, workspaceId),
    listIdsInCreationOrder: () => listWorkspaceIdsInCreationOrder(database),
    listProjectIds: (workspaceId) => listWorkspaceProjectIds(database, workspaceId),
  };
};
