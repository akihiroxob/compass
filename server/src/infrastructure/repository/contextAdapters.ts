import { listGrantedRoles, writeProjectOwnerMembership, type AccessProjectReaders } from "@compass/access";
import {
  isProjectArchived,
  listProjectIdsInCreationOrder,
  SQLiteProjectRepository,
  type ProjectOwnerMembershipWriter,
} from "@compass/direction";
import type { WorkExternalReaders } from "@compass/work";
import { asAccessDatabase, asAccessTransaction, asDirectionDatabase } from "../../bootstrap/database/contextDatabase.ts";

/**
 * Context間で同じ接続・transactionを共有する読み書きの配線。各Contextは他Contextのtableを直接扱わず、
 * 所有Contextが公開する関数をserverがここで渡す。受け取った接続・transactionのまま実行する。
 */

/** WorkがClaim・状態遷移と同じtransactionで読む、Role Grant（Access）とProject状態（Direction）。 */
export const workExternalReaders: WorkExternalReaders = (executor) => {
  const access = asAccessDatabase(executor);
  const direction = asDirectionDatabase(executor);
  const projects = new SQLiteProjectRepository(direction);
  return {
    grants: {
      listRoles: (projectId, principalId) => listGrantedRoles(access, projectId, principalId),
    },
    projects: {
      exists: (projectId) => projects.exists(projectId),
      isArchived: (projectId) => isProjectArchived(direction, projectId),
    },
  };
};

/** AccessがMembership・Grant・Credentialの書込と同じtransactionで読む、Project状態（Direction）。 */
export const accessProjectReaders: AccessProjectReaders = (executor) => {
  const database = asDirectionDatabase(executor);
  const projects = new SQLiteProjectRepository(database);
  return {
    exists: (projectId) => projects.exists(projectId),
    isArchived: (projectId) => isProjectArchived(database, projectId),
    listIdsInCreationOrder: () => listProjectIdsInCreationOrder(database),
  };
};

/** DirectionのProject作成のtransactionで、作成者の初期owner Membership（Access）を書く。 */
export const projectOwnerMembershipWriter: ProjectOwnerMembershipWriter = (transaction, input) =>
  writeProjectOwnerMembership(asAccessTransaction(transaction), input);
