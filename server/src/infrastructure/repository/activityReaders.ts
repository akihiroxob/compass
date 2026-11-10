
import { type ActivityScopeReader } from "@compass/activity";
import { findWorkspaceStatus, listWorkspaceProjectResourceIds, SQLiteProjectRepository } from "@compass/organization";

import { asOrganizationDatabase } from "../database/contextDatabase.ts";
import { projectRepositoryReferenceFinder } from "./organizationLinks.ts";

/**
 * Activityの記録・取得の対象（Organization）の状態と、`project_resource`参照として受け付けるRepository・ResourceのID。
 * ProjectはそのProjectに登録済みのもの、Workspaceは所属Project（archivedを含む）に登録済みのものを返す。
 */
export const activityScopeReader = (executor: Parameters<typeof asOrganizationDatabase>[0]): ActivityScopeReader => {
  const database = asOrganizationDatabase(executor);
  const projects = new SQLiteProjectRepository(database, projectRepositoryReferenceFinder);
  return {
    find: async (target) => {
      if (target.kind === "workspace") {
        const status = await findWorkspaceStatus(database, target.id);
        if (status === null) return null;
        return {
          workspaceId: target.id,
          projectId: null,
          archived: status === "archived",
          resourceIds: await listWorkspaceProjectResourceIds(database, target.id),
        };
      }
      const project = await projects.findById(target.id);
      if (!project) return null;
      return {
        workspaceId: project.workspaceId,
        projectId: project.id,
        archived: project.status === "archived",
        resourceIds: [...project.repositories, ...project.resources].map(({ id }) => id),
      };
    },
  };
};
