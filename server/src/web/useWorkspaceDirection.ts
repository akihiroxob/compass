import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "./api";
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
 * Projectの画面から、そのProjectが所属するWorkspaceのDirectionを扱うための`workspaceId`と変更可否を取得する。
 * Directionの参照・変更はWorkspace Membershipで認可され、Project Membershipからは継承しない。
 * 表示の判定であり、拒否は常にサーバーが行う。
 */
export const useProjectWorkspaceDirection = (projectId: string): WorkspaceDirectionState => {
  // 結果は対象のprojectIdと組で持ち、入力が変わった最初のrenderから旧Projectの結果を使わない。
  const [stored, setStored] = useState<{ projectId: string; state: WorkspaceDirectionState } | null>(null);
  useEffect(() => {
    let current = true;
    const settle = (state: WorkspaceDirectionState) => { if (current) setStored({ projectId, state }); };
    request<{ project: Project }>(`/api/projects/${projectId}`)
      .then(({ project }) =>
        request<{ workspace: { status: "active" | "archived" }; myRole: HumanRole }>(`/api/workspaces/${project.workspaceId}`)
          .then(({ workspace, myRole }) => settle({ access: workspaceDirectionAccess(workspace, myRole), workspaceId: project.workspaceId })),
      )
      .catch((reason: unknown) => settle({
        access: "error",
        workspaceId: null,
        message: loadFailureMessage(classifyError(reason), "ProjectまたはWorkspaceが見つからないか、WorkspaceのDirectionを閲覧する権限がありません。Workspaceのownerに招待を依頼してください。"),
      }));
    return () => { current = false; };
  }, [projectId]);
  return stored !== null && stored.projectId === projectId ? stored.state : { access: "loading", workspaceId: null };
};
