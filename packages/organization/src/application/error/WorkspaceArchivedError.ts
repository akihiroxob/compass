import { ConflictError } from "@compass/shared";

/**
 * archivedのWorkspaceへの書込、またはarchivedのWorkspaceの再archive。`workspaceStatus`で、
 * Projectの`projectStatus`やIntent / Outcomeの`status`と区別する。HTTP・MCP・CLIの対応は`ConflictError`と同じ。
 */
export class WorkspaceArchivedError extends ConflictError {
  constructor(workspaceId: string, message = `Workspace ${workspaceId} is archived and can no longer be changed`) {
    super(message, { workspaceStatus: "archived" });
    this.name = "WorkspaceArchivedError";
  }
}
