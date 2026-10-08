import type { Workspace, WorkspaceStatus } from "./Workspace.ts";

/** 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。 */
export type CreateWorkspaceInput = {
  name: string;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
};

/** 未指定（undefined）の項目は変更しない。配列は指定すると全体を置き換える。 */
export type UpdateWorkspaceInput = {
  name?: string;
  mission?: string;
  vision?: string | null;
  principles?: string[];
  constraints?: string[];
};

export type UpdateWorkspaceResult =
  | { kind: "updated"; workspace: Workspace }
  | { kind: "not_found" }
  | { kind: "workspace_archived" };

export type ArchiveWorkspaceResult =
  | { kind: "archived"; workspace: Workspace }
  | { kind: "not_found" }
  | { kind: "already_archived" };

export interface WorkspaceRepository {
  /**
   * 常にactiveで作成する。statusは入力から受け取らない。
   * `ownerHumanUserId`を渡すと、そのHumanのowner Membershipを同一transactionで作成する（部分保存しない）。
   */
  create(input: CreateWorkspaceInput, ownerHumanUserId?: string): Promise<Workspace>;
  /** 親と子要素は同一transactionで更新する。archivedのWorkspaceは更新しない。 */
  update(workspaceId: string, input: UpdateWorkspaceInput): Promise<UpdateWorkspaceResult>;
  /**
   * activeからarchivedへ遷移する唯一の操作。status・archivedAt・archiveReason・updatedAtを1 transactionで書く。
   * 既にarchivedなら何も書かない（理由・日時を上書きしない）。
   */
  archive(workspaceId: string, reason: string): Promise<ArchiveWorkspaceResult>;
  /** 指定した状態のWorkspaceだけを返す。既定はactive。 */
  findAll(status?: WorkspaceStatus): Promise<Workspace[]>;
  findById(workspaceId: string): Promise<Workspace | null>;
}
