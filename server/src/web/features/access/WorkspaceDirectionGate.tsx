import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ErrorState, Loading } from "../../components/StateCard";
import { projectOperationDeniedMessage } from "./projectAccess";
import { useWorkspaceDirection, type DirectionScope } from "./useWorkspaceDirection";

/**
 * Direction（Intent・Outcome）の作成・編集の画面をURLで直接開いた場合も、所属WorkspaceのstatusとWorkspace Membershipの`myRole`で
 * 変更できるときだけ`children`を描画する。行えないときはフォームを出さず、理由と戻り先だけを表示する（拒否は常にサーバーも行う）。
 */
export const WorkspaceDirectionGate = ({ scope, back, children }: { scope: DirectionScope; back: { to: string; label: string }; children: (workspaceId: string) => ReactNode }) => {
  const state = useWorkspaceDirection(scope);
  if (state.access === "allowed") return <>{children(state.workspaceId)}</>;
  return <main className="narrow"><Link to={back.to} className="back-link">{back.label}</Link>{state.access === "loading" ? <Loading /> : <ErrorState message={state.access === "error" ? state.message : projectOperationDeniedMessage(state.access, "Workspace")} />}</main>;
};
