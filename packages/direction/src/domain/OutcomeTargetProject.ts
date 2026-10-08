import type { OutcomeStatus } from "./Outcome.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/**
 * Outcomeを担当するProject（Strategistが明示する）。ProjectはOutcomeと同じWorkspaceに属する。
 * 必要になるまでstatus・priority等は持たない。
 */
export type OutcomeTargetProject = {
  outcomeId: string;
  projectId: string;
  createdAt: number;
};

/** 一覧の参照モデル。Project（Organizationが所有）の現在の状態を添え、archived Targetの見直しを判断できるようにする。 */
export type OutcomeTargetProjectView = OutcomeTargetProject & { projectStatus: "active" | "archived" };

/** 追加・解除で共通する拒否。別WorkspaceのOutcome・Projectは見つからない扱い。 */
type OutcomeTargetRejection =
  | { kind: "outcome_not_found" }
  | { kind: "outcome_not_active"; status: OutcomeStatus }
  | { kind: "project_not_found" }
  | WorkspaceArchivedResult;

export type AddOutcomeTargetProjectResult =
  | { kind: "added"; target: OutcomeTargetProject }
  | { kind: "already_target" }
  | { kind: "project_archived" }
  | OutcomeTargetRejection;

export type RemoveOutcomeTargetProjectResult =
  | { kind: "removed"; target: OutcomeTargetProject }
  | { kind: "not_target" }
  | OutcomeTargetRejection;

/**
 * Targetの追加・解除は、Workspace・Outcome・Projectの状態検査と同一transactionで行う。解除はTargetの関連だけを消し、
 * 既存Story・Execution Summary・Evidenceの参照は変えない。archivedのProjectは追加できないが、解除はできる。
 */
export interface OutcomeTargetProjectRepository {
  add(workspaceId: string, outcomeId: string, projectId: string): Promise<AddOutcomeTargetProjectResult>;
  remove(workspaceId: string, outcomeId: string, projectId: string): Promise<RemoveOutcomeTargetProjectResult>;
  /** Workspace内のOutcomeのTargetを設定順で返す。Outcomeが無ければnull。 */
  listByOutcome(workspaceId: string, outcomeId: string): Promise<OutcomeTargetProjectView[] | null>;
}
