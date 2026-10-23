// Workspaceの概要・方向が使う所属Projectの取得。Project詳細はProject Membershipで認可され、Workspace Membershipから継承しない。
import { request } from "../../api";
import { workspaceApiPath } from "../../paths";
import { projectsApiPath, type Project } from "../project";
import { withProjectAccess, type WorkspaceProject } from "./workspace";

export type OverviewProject = { project: WorkspaceProject; canOpen: boolean };

/** 所属Project（active・archived）と、HumanがProject Membershipで開けるか。archivedのTargetも名前を引けるようにする。 */
export const loadProjects = (workspaceId: string): Promise<OverviewProject[]> =>
  Promise.all(
    (["active", "archived"] as const).map((status) =>
      Promise.all([
        request<{ projects: WorkspaceProject[] }>(workspaceApiPath(workspaceId, `/projects${status === "archived" ? "?status=archived" : ""}`)),
        request<{ projects: Project[] }>(projectsApiPath(status)),
      ]).then(([workspace, member]) => withProjectAccess(workspace.projects, new Set(member.projects.map(({ id }) => id)))),
    ),
  ).then((lists) => lists.flat());
