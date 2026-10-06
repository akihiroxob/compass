import type { Project, ProjectDetail, ProjectStatus } from "./Project.ts";

/**
 * 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。
 * Mission等は既存の公開契約どおりProjectの入力で受け取り、作成するWorkspaceへ書く。
 */
export type CreateProjectInput = {
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
  repositories: { name: string; url: string }[];
  resources: { name: string; url: string; kind: string | null }[];
};

/** 既存のWorkspaceへProjectを作成する入力。Mission等はWorkspaceの正本を使うため受け取らない。 */
export type CreateWorkspaceProjectInput = Pick<CreateProjectInput, "name" | "description" | "repositories" | "resources">;

export type CreateWorkspaceProjectResult =
  | { kind: "created"; project: ProjectDetail }
  | { kind: "not_found" }
  | { kind: "workspace_archived" };

/**
 * 未指定（undefined）の項目は変更しない。Repository / Resourceの`id`は既存行の維持に使う。
 * Mission等は所属Workspaceの値を更新する。
 */
export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
  mission?: string;
  vision?: string | null;
  principles?: string[];
  constraints?: string[];
  repositories?: { id?: string; name: string; url: string }[];
  resources?: { id?: string; name: string; url: string; kind: string | null }[];
};

/** Projectがarchivedのため書込を拒否した結果。 */
export type ProjectArchivedResult = { kind: "project_archived" };

/**
 * 外したRepositoryにADR Handoff Request/Reference（Direction）が残っており、削除するとその監査記録が
 * 参照先を失うため拒否した結果。
 */
export type RepositoryReferencedResult = {
  kind: "repository_referenced";
  repositoryId: string;
  repositoryName: string;
};

export type UpdateProjectResult =
  | { kind: "updated"; project: ProjectDetail }
  | { kind: "not_found" }
  | RepositoryReferencedResult
  | ProjectArchivedResult
  | { kind: "workspace_archived"; workspaceId: string };

export type ArchiveProjectResult =
  | { kind: "archived"; project: ProjectDetail }
  | { kind: "not_found" }
  | { kind: "already_archived" };

export interface ProjectRepository {
  /**
   * Projectと、その戦略値を持つ専用のWorkspaceを同一transactionで作成する。常にactiveで、statusは入力から受け取らない。
   * `ownerHumanUserId`を渡すと、そのHumanのProjectとWorkspaceのowner Membershipを同一transactionで作成する（部分保存しない）。
   */
  create(input: CreateProjectInput, ownerHumanUserId?: string): Promise<ProjectDetail>;
  /**
   * 既存のactiveなWorkspaceへProjectを作成する。存在とarchivedの検査は書込と同じtransactionで行う。
   * `ownerHumanUserId`を渡すと、そのHumanのProjectのowner Membershipだけを同一transactionで作成する（Workspaceの
   * Membershipは変えない）。
   */
  createInWorkspace(
    workspaceId: string,
    input: CreateWorkspaceProjectInput,
    ownerHumanUserId?: string,
  ): Promise<CreateWorkspaceProjectResult>;
  /** Project・子要素・所属Workspaceの戦略値を同一transactionで更新する。archivedのProjectは更新しない。 */
  update(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResult>;
  /**
   * activeからarchivedへ遷移する唯一の操作。status・archivedAt・archiveReason・updatedAtを1 transactionで書く。
   * 既にarchivedなら何も書かない（理由・日時を上書きしない）。子データには触れない。
   * 所属Workspaceに他のactiveなProjectが無ければ、Workspaceも同じ理由・日時でarchiveする。
   */
  archive(projectId: string, reason: string): Promise<ArchiveProjectResult>;
  /** 指定した状態のProjectだけを返す。既定はactive。 */
  findAll(status?: ProjectStatus): Promise<ProjectDetail[]>;
  /**
   * 指定Workspaceに所属し、指定した状態のProjectだけを返す。既定はactive。Mission等はWorkspaceが正本のため合成しない。
   */
  findAllInWorkspace(workspaceId: string, status?: ProjectStatus): Promise<Project[]>;
  findById(projectId: string): Promise<Project | null>;
  findDetailById(projectId: string): Promise<ProjectDetail | null>;
  exists(projectId: string): Promise<boolean>;
}
