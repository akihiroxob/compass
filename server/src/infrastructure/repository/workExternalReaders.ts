import { isProjectArchived, SQLiteProjectRepository } from "@compass/direction";
import type { WorkExternalReaders } from "@compass/work";
import { asApplicationDatabase, asDirectionDatabase } from "../../bootstrap/database/contextDatabase.ts";

/**
 * WorkがClaim・状態遷移と同じtransactionで読む、Project Role Grant（Access）とProject状態（Direction）。
 * Workから渡された接続・transactionのまま読み、書き込まない。
 */
export const workExternalReaders: WorkExternalReaders = (executor) => {
  const database = asApplicationDatabase(executor);
  const projects = new SQLiteProjectRepository(asDirectionDatabase(database));
  return {
    grants: {
      async listRoles(projectId, principalId) {
        const rows = await database
          .selectFrom("project_grant")
          .select("role")
          .where("project_id", "=", projectId)
          .where("principal_id", "=", principalId)
          .execute();
        return rows.map((row) => row.role);
      },
    },
    projects: {
      exists: (projectId) => projects.exists(projectId),
      isArchived: (projectId) => isProjectArchived(asDirectionDatabase(database), projectId),
    },
  };
};
