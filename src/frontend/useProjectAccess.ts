import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "./api";
import type { HumanRole } from "./features/member/members";
import type { HumanProjectOperation } from "../domain/model/HumanAuth";
import { canOperate } from "./permissions";
import { projectOperationAccess, type ProjectOperationAccess } from "./projectAccess";
import type { Project } from "./projectForm";

export type ProjectOperationState = { access: ProjectOperationAccess | "loading" } | { access: "error"; message: string };

/**
 * Projectのstatusと`myRole`から、`operation`を行えるかを取得する。権限表はdomainの`humanProjectPermissions`を`canOperate`経由で使う。取得できるまでは`loading`、失敗は`error`。
 * 表示の判定であり、拒否は常にサーバーが行う。
 */
export const useProjectOperationState = (projectId: string, operation: HumanProjectOperation): ProjectOperationState => {
  const [state, setState] = useState<ProjectOperationState>({ access: "loading" });
  useEffect(() => {
    let current = true;
    setState({ access: "loading" });
    request<{ project: Project; myRole: HumanRole }>(`/api/projects/${projectId}`)
      .then(({ project, myRole }) => current && setState({ access: projectOperationAccess(project, canOperate(myRole, operation)) }))
      .catch((reason: unknown) => current && setState({ access: "error", message: loadFailureMessage(classifyError(reason), "Projectが見つかりません。") }));
    return () => { current = false; };
  }, [projectId, operation]);
  return state;
};

/** 子画面で`operation`の導線を出すか。取得できるまで・取得に失敗した場合は`false`で、導線を出さない。 */
export const useProjectOperation = (projectId: string, operation: HumanProjectOperation): boolean =>
  useProjectOperationState(projectId, operation).access === "allowed";
