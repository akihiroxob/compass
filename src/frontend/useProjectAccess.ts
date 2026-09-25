import { useEffect, useState } from "react";
import { request } from "./api";
import type { HumanRole } from "./features/member/members";
import { canOperate } from "./permissions";
import type { HumanProjectOperation } from "../domain/model/HumanAuth";
import type { Project } from "./projectForm";

/**
 * active Projectで、`myRole`が`operation`を許されるときだけ`true`（archivedでは変更できない）。
 * 権限表はdomainの`humanProjectPermissions`を`canOperate`経由で使う。
 */
export const canOperateOnProject = (project: Pick<Project, "status">, myRole: HumanRole | null, operation: HumanProjectOperation): boolean =>
  project.status !== "archived" && canOperate(myRole, operation);

/**
 * Projectのstatusと`myRole`から、子画面で`operation`の導線を出すか。取得できるまで・取得に失敗した場合は`false`で、
 * 導線を出さない（導線の非表示は表示上の配慮であり、拒否はサーバーが行う）。
 */
export const useProjectOperation = (projectId: string, operation: HumanProjectOperation): boolean => {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let current = true;
    setAllowed(false);
    request<{ project: Project; myRole: HumanRole }>(`/api/projects/${projectId}`)
      .then(({ project, myRole }) => current && setAllowed(canOperateOnProject(project, myRole, operation)))
      .catch(() => current && setAllowed(false));
    return () => { current = false; };
  }, [projectId, operation]);
  return allowed;
};
