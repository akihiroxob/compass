import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { projectOperationDeniedMessage } from "../projectAccess";
import { useProjectWorkspaceDirection } from "../useWorkspaceDirection";
import { Shell } from "./Shell";
import { ErrorState, Loading } from "./StateCard";

/**
 * Direction（Intent・Outcome）の作成・編集の画面をURLで直接開いた場合も、所属WorkspaceのstatusとWorkspace Membershipの`myRole`で
 * 変更できるときだけ`children`を描画する。行えないときはフォームを出さず、理由と戻り先だけを表示する（拒否は常にサーバーも行う）。
 */
export const WorkspaceDirectionGate = ({ projectId, back, children }: { projectId: string; back: { to: string; label: string }; children: (workspaceId: string) => ReactNode }) => {
  const state = useProjectWorkspaceDirection(projectId);
  if (state.access === "allowed") return <>{children(state.workspaceId)}</>;
  return <Shell><main className="narrow"><Link to={back.to} className="back-link">{back.label}</Link>{state.access === "loading" ? <Loading /> : <ErrorState message={state.access === "error" ? state.message : projectOperationDeniedMessage(state.access, "Workspace")} />}</main></Shell>;
};
