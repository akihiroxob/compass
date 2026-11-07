import { useEffect, useState } from "react";
import type { HumanRole } from "@compass/access/domain";
import { classifyError, loadFailureMessage, request, type FetchLike } from "../../api";
import { canOperateWorkspace } from "./permissions";
import { projectOperationAccess, type ProjectOperationAccess } from "./projectAccess";

export type WorkspaceDirectionState =
  | { access: "loading"; workspaceId: null }
  | { access: "error"; workspaceId: null; message: string }
  | { access: ProjectOperationAccess; workspaceId: string };

/** Workspaceのstatusと`myRole`（Workspace Membership）から、Directionを変更できるかを決める。 */
export const workspaceDirectionAccess = (workspace: { status: "active" | "archived" }, myRole: HumanRole | null): ProjectOperationAccess =>
  projectOperationAccess(workspace, canOperateWorkspace(myRole, "direction.write"));

const directionLoadFailure = (reason: unknown): WorkspaceDirectionState => ({
  access: "error",
  workspaceId: null,
  message: loadFailureMessage(classifyError(reason), "ProjectまたはWorkspaceが見つからないか、WorkspaceのDirectionを閲覧する権限がありません。Workspaceのownerに招待を依頼してください。"),
});

const loadDirectionAccess = (workspaceId: string, fetchImpl?: FetchLike): Promise<WorkspaceDirectionState> =>
  request<{ workspace: { status: "active" | "archived" }; myRole: HumanRole }>(`/api/workspaces/${workspaceId}`, undefined, fetchImpl)
    .then(({ workspace, myRole }): WorkspaceDirectionState => ({ access: workspaceDirectionAccess(workspace, myRole), workspaceId }));

/** Workspaceの`workspaceId`と、そのDirectionを変更できるか（Workspaceのstatusと`myRole`）を取得する。 */
export const loadWorkspaceDirection = (workspaceId: string, fetchImpl?: FetchLike): Promise<WorkspaceDirectionState> =>
  loadDirectionAccess(workspaceId, fetchImpl).catch(directionLoadFailure);

/**
 * Projectが所属するWorkspaceの`workspaceId`と、WorkspaceのDirectionを変更できるかを取得する。
 * Directionの参照・変更はWorkspace Membershipで認可される（ProjectのWorkも同じMembershipで認可する）。
 */
export const loadProjectWorkspaceDirection = (projectId: string, fetchImpl?: FetchLike): Promise<WorkspaceDirectionState> =>
  request<{ project: { workspaceId: string } }>(`/api/projects/${projectId}`, undefined, fetchImpl)
    .then(({ project }) => loadDirectionAccess(project.workspaceId, fetchImpl))
    .catch(directionLoadFailure);

/** Directionを扱う画面の対象。ProjectならProjectの所属Workspaceを解決する。 */
export type DirectionScope = { projectId: string } | { workspaceId: string };

const scopeKey = (scope: DirectionScope) => ("projectId" in scope ? `project:${scope.projectId}` : `workspace:${scope.workspaceId}`);

/** 画面のWorkspace Directionの状態を取得する。表示の判定であり、拒否は常にサーバーが行う。 */
export const useWorkspaceDirection = (scope: DirectionScope): WorkspaceDirectionState => {
  const key = scopeKey(scope);
  // 結果は対象のkeyと組で持ち、入力が変わった最初のrenderから旧対象の結果を使わない。
  const [stored, setStored] = useState<{ key: string; state: WorkspaceDirectionState } | null>(null);
  useEffect(() => {
    let current = true;
    const load = "projectId" in scope ? loadProjectWorkspaceDirection(scope.projectId) : loadWorkspaceDirection(scope.workspaceId);
    void load.then((state) => { if (current) setStored({ key, state }); });
    return () => { current = false; };
  }, [key]);
  return stored !== null && stored.key === key ? stored.state : { access: "loading", workspaceId: null };
};

/** Projectの画面で、所属WorkspaceのDirectionを扱うための状態を取得する。 */
export const useProjectWorkspaceDirection = (projectId: string): WorkspaceDirectionState => useWorkspaceDirection({ projectId });
