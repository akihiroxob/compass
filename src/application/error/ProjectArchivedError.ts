import { ConflictError } from "./ConflictError.ts";

/**
 * archivedのProjectへの書込、またはarchivedのProjectの再archive。`projectStatus`で、
 * Intent / Outcomeの状態を表す既存の`status`と区別する。HTTP・MCP・CLIの対応は`ConflictError`と同じ。
 */
export class ProjectArchivedError extends ConflictError {
  constructor(projectId: string, message = `Project ${projectId} is archived and can no longer be changed`) {
    super(message, { projectStatus: "archived" });
    this.name = "ProjectArchivedError";
  }
}
