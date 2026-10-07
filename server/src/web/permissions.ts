import { hasMinimumRole, humanProjectPermissions, humanWorkspacePermissions, type HumanProjectOperation, type HumanRole, type HumanWorkspaceOperation } from "@compass/access/domain";

/**
 * `myRole`で操作の導線を出すか。権限表はdomainの1箇所（`humanProjectPermissions`）を使い、UIに重複させない。
 * 導線の表示だけの判定で、拒否は常にserverが行う。
 */
export const canOperate = (myRole: HumanRole | null, operation: HumanProjectOperation): boolean =>
  myRole !== null && hasMinimumRole(myRole, humanProjectPermissions[operation]);

/** Workspace Membershipの`myRole`で、Workspace操作（Direction等）の導線を出すか。権限表はdomainの`humanWorkspacePermissions`。 */
export const canOperateWorkspace = (myRole: HumanRole | null, operation: HumanWorkspaceOperation): boolean =>
  myRole !== null && hasMinimumRole(myRole, humanWorkspacePermissions[operation]);
