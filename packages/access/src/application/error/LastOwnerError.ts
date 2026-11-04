import { ConflictError } from "@compass/shared";

/** Workspaceの有効なowner数を0にする変更。HTTPは`409 LAST_OWNER`で返す。 */
export class LastWorkspaceOwnerError extends ConflictError {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} must keep at least one owner`, { conflict: "LAST_OWNER" });
    this.name = "LastWorkspaceOwnerError";
  }
}
