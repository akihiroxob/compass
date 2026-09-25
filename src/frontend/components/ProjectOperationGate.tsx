import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { HumanProjectOperation } from "../../domain/model/HumanAuth";
import { projectOperationDeniedMessage } from "../projectAccess";
import { useProjectOperationState } from "../useProjectAccess";
import { Shell } from "./Shell";
import { ErrorState, Loading } from "./StateCard";

/**
 * 作成・編集の画面をURLで直接開いた場合も、Projectのstatusと`myRole`で`operation`を行えるときだけ`children`を描画する。
 * 行えないときはフォームを出さず、理由と戻り先だけを表示する（拒否は常にサーバーも行う）。
 */
export const ProjectOperationGate = ({ projectId, operation, back, children }: { projectId: string; operation: HumanProjectOperation; back: { to: string; label: string }; children: ReactNode }) => {
  const state = useProjectOperationState(projectId, operation);
  if (state.access === "allowed") return <>{children}</>;
  return <Shell><main className="narrow"><Link to={back.to} className="back-link">{back.label}</Link>{state.access === "loading" ? <Loading /> : <ErrorState message={state.access === "error" ? state.message : projectOperationDeniedMessage(state.access)} />}</main></Shell>;
};
