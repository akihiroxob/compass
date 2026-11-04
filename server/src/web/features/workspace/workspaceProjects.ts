// Workspaceの概要・方向が使う所属Projectの取得。Project詳細・Workも同じWorkspace Membershipで認可される（ADR 0003）。
import { request } from "../../api";
import { workspaceApiPath } from "../../paths";
import type { WorkspaceProject } from "./workspace";

export type OverviewProject = { project: WorkspaceProject };

/** 所属Project（active・archived）。archivedのTargetも名前を引けるようにする。 */
export const loadProjects = (workspaceId: string): Promise<OverviewProject[]> =>
  Promise.all(
    (["active", "archived"] as const).map((status) =>
      request<{ projects: WorkspaceProject[] }>(workspaceApiPath(workspaceId, `/projects${status === "archived" ? "?status=archived" : ""}`))
        .then(({ projects }) => projects.map((project) => ({ project }))),
    ),
  ).then((lists) => lists.flat());
