import { ConflictError } from "./ConflictError.ts";

/** Projectの有効なowner数を0にする変更。HTTPは`409 LAST_OWNER`（Task 42）で返す。 */
export class LastOwnerError extends ConflictError {
  constructor(projectId: string) {
    super(`Project ${projectId} must keep at least one owner`, { conflict: "LAST_OWNER" });
    this.name = "LastOwnerError";
  }
}
