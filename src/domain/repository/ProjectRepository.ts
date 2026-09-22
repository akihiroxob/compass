import type { Project, ProjectStatus } from "../model/Project.ts";
import type { CreateProjectInput, UpdateProjectInput } from "../../shared/projectSchema.ts";

/**
 * Projectがarchivedのため書込を拒否した結果。Project配下の書込（Intent・Outcome・Grantを含む）は、
 * 各Repositoryが書込と同一transactionでProjectの状態を検査してこの結果を返す。
 */
export type ProjectArchivedResult = { kind: "project_archived" };

/**
 * 外したRepositoryにADR Handoff Request/Reference（Task 28）が残っており、削除するとその監査記録が
 * 参照先を失うため拒否した結果。
 */
export type RepositoryReferencedResult = {
  kind: "repository_referenced";
  repositoryId: string;
  repositoryName: string;
};

export type UpdateProjectResult =
  | { kind: "updated"; project: Project }
  | { kind: "not_found" }
  | RepositoryReferencedResult
  | ProjectArchivedResult;

export type ArchiveProjectResult =
  | { kind: "archived"; project: Project }
  | { kind: "not_found" }
  | { kind: "already_archived" };

export interface ProjectRepository {
  /** 常にactiveで作成する。statusは入力から受け取らない。 */
  create(input: CreateProjectInput): Promise<Project>;
  /** 親と子要素は同一transactionで更新する。archivedのProjectは更新しない。 */
  update(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResult>;
  /**
   * activeからarchivedへ遷移する唯一の操作。status・archivedAt・archiveReason・updatedAtを1 transactionで書く。
   * 既にarchivedなら何も書かない（理由・日時を上書きしない）。子データには触れない。
   */
  archive(projectId: string, reason: string): Promise<ArchiveProjectResult>;
  /** 指定した状態のProjectだけを返す。既定はactive。 */
  findAll(status?: ProjectStatus): Promise<Project[]>;
  findById(projectId: string): Promise<Project | null>;
  exists(projectId: string): Promise<boolean>;
}
