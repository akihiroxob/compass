import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "./api";
import type { HumanRole } from "./features/member/members";
import type { HumanProjectOperation } from "../domain/model/HumanAuth";
import { canOperate } from "./permissions";
import { currentProjectOperationResult, projectOperationAccess, type KeyedProjectOperationResult, type ProjectOperationAccess } from "./projectAccess";
import type { Project } from "./projectForm";

export type ProjectOperationState = { access: ProjectOperationAccess | "loading" } | { access: "error"; message: string };

/**
 * Projectのstatusと`myRole`から、`operation`を行えるかを取得する。権限表はdomainの`humanProjectPermissions`を`canOperate`経由で使う。取得できるまでは`loading`、失敗は`error`。
 * 表示の判定であり、拒否は常にサーバーが行う。
 */
export const useProjectOperationState = (projectId: string, operation: HumanProjectOperation): ProjectOperationState => {
  // 判定結果は対象のprojectId・operationと組で持ち、入力が変わった最初のrenderから旧Projectの結果を使わない。
  const [stored, setStored] = useState<KeyedProjectOperationResult<ProjectOperationState> | null>(null);
  useEffect(() => {
    let current = true;
    const settle = (result: ProjectOperationState) => { if (current) setStored({ projectId, operation, result }); };
    request<{ project: Project; myRole: HumanRole }>(`/api/projects/${projectId}`)
      .then(({ project, myRole }) => settle({ access: projectOperationAccess(project, canOperate(myRole, operation)) }))
      .catch((reason: unknown) => settle({ access: "error", message: loadFailureMessage(classifyError(reason), "Projectが見つかりません。") }));
    return () => { current = false; };
  }, [projectId, operation]);
  return currentProjectOperationResult(stored, projectId, operation) ?? { access: "loading" };
};

/** 子画面で`operation`の導線を出すか。取得できるまで・取得に失敗した場合は`false`で、導線を出さない。 */
export const useProjectOperation = (projectId: string, operation: HumanProjectOperation): boolean =>
  useProjectOperationState(projectId, operation).access === "allowed";
