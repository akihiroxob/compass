// Workspaceの作成・編集フォームの値（S09-03）。テストからも読み込むため、型以外のmoduleをimportしない純関数だけを置く。
import type { Workspace } from "./workspace.ts";

/** Mission等の戦略値はWorkspaceが正本。所属Projectはこの値を複製せずに参照する。 */
export type WorkspaceFormValues = {
  name: string;
  mission: string;
  vision: string;
  principles: string[];
  constraints: string[];
};

export const emptyWorkspaceFormValues: WorkspaceFormValues = { name: "", mission: "", vision: "", principles: [], constraints: [] };

/** 保存済みWorkspaceから編集フォームの初期値を作る。未設定（null）は空欄として表示する。 */
export const workspaceFormValues = (workspace: Workspace): WorkspaceFormValues => ({
  name: workspace.name,
  mission: workspace.mission,
  vision: workspace.vision ?? "",
  principles: [...workspace.principles],
  constraints: [...workspace.constraints],
});
