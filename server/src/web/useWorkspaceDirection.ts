import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request, type FetchLike } from "./api";
import type { HumanRole } from "./features/member/members";
import { canOperateWorkspace } from "./permissions";
import { projectOperationAccess, type ProjectOperationAccess } from "./projectAccess";
import type { Project } from "./projectForm";

export type WorkspaceDirectionState =
  | { access: "loading"; workspaceId: null }
  | { access: "error"; workspaceId: null; message: string }
  | { access: ProjectOperationAccess; workspaceId: string };

/** Workspaceのstatusと`myRole`（Workspace Membership）から、Directionを変更できるかを決める。 */
export const workspaceDirectionAccess = (workspace: { status: "active" | "archived" }, myRole: HumanRole | null): ProjectOperationAccess =>
  projectOperationAccess(workspace, canOperateWorkspace(myRole, "direction.write"));

/**
 * Projectが所属するWorkspaceの`workspaceId`と、WorkspaceのDirectionを変更できるかを取得する。
 * Directionの参照・変更はWorkspace Membershipで認可され、Project Membershipからは継承しない。
 */
export const loadProjectWorkspaceDirection = (projectId: string, fetchImpl?: FetchLike): Promise<WorkspaceDirectionState> =>
  request<{ project: Project }>(`/api/projects/${projectId}`, undefined, fetchImpl)
    .then(({ project }) =>
      request<{ workspace: { status: "active" | "archived" }; myRole: HumanRole }>(`/api/workspaces/${project.workspaceId}`, undefined, fetchImpl)
        .then(({ workspace, myRole }): WorkspaceDirectionState => ({ access: workspaceDirectionAccess(workspace, myRole), workspaceId: project.workspaceId })),
    )
    .catch((reason: unknown): WorkspaceDirectionState => ({
      access: "error",
      workspaceId: null,
      message: loadFailureMessage(classifyError(reason), "ProjectまたはWorkspaceが見つからないか、WorkspaceのDirectionを閲覧する権限がありません。Workspaceのownerに招待を依頼してください。"),
    }));

/**
 * Projectの画面で、所属WorkspaceのDirectionを扱うための状態を取得する。表示の判定であり、拒否は常にサーバーが行う。
 */
export const useProjectWorkspaceDirection = (projectId: string): WorkspaceDirectionState => {
  // 結果は対象のprojectIdと組で持ち、入力が変わった最初のrenderから旧Projectの結果を使わない。
  const [stored, setStored] = useState<{ projectId: string; state: WorkspaceDirectionState } | null>(null);
  useEffect(() => {
    let current = true;
    void loadProjectWorkspaceDirection(projectId).then((state) => { if (current) setStored({ projectId, state }); });
    return () => { current = false; };
  }, [projectId]);
  return stored !== null && stored.projectId === projectId ? stored.state : { access: "loading", workspaceId: null };
};
