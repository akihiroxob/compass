import { hasMinimumRole, humanProjectPermissions, type HumanProjectOperation, type HumanRole } from "../domain/model/HumanAuth";

/**
 * `myRole`で操作の導線を出すか。権限表はdomainの1箇所（`humanProjectPermissions`）を使い、UIに重複させない。
 * 導線の表示だけの判定で、拒否は常にserverが行う。
 */
export const canOperate = (myRole: HumanRole | null, operation: HumanProjectOperation): boolean =>
  myRole !== null && hasMinimumRole(myRole, humanProjectPermissions[operation]);
