import type { IntentStatus } from "./Intent.ts";
import type { Outcome, OutcomeStatus } from "./Outcome.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/** 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。 */
export type CreateOutcomeInput = {
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  successCriteria: { description: string; measurement: string; target: string | null }[];
};

export type UpdateOutcomeInput = {
  title?: string;
  hypothesis?: string | null;
};

/** 作成の結果。Intentが無い場合と、activeでない場合を区別する。 */
export type CreateOutcomeResult =
  | { kind: "created"; outcome: Outcome }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | WorkspaceArchivedResult;

/** 更新・取消の結果。Intentが無い場合と、Outcomeが無い場合と、activeでない場合を区別する。 */
export type ChangeOutcomeResult =
  | { kind: "changed"; outcome: Outcome }
  | { kind: "intent_not_found" }
  | { kind: "outcome_not_found" }
  | { kind: "not_active"; status: OutcomeStatus }
  | WorkspaceArchivedResult;

/**
 * 成功条件はOutcomeの一部として作成・取得する。作成後に固定されるため、
 * Criterionを更新・削除するメソッドは意図的に持たない。
 */
export interface OutcomeRepository {
  /** Outcomeと全Success Criterionを1 transactionで保存する。activeなIntent配下にだけ作成できる。 */
  create(workspaceId: string, intentId: string, input: CreateOutcomeInput): Promise<CreateOutcomeResult>;
  /** 指定したWorkspace・Intent配下のOutcomeを新しい順で、成功条件をposition順に含めて返す。 */
  findByIntent(workspaceId: string, intentId: string): Promise<Outcome[]>;
  /** 他WorkspaceまたはIntent配下のOutcome IDはnullとして扱う。 */
  findById(workspaceId: string, intentId: string, outcomeId: string): Promise<Outcome | null>;
  /** Intentを指定せず、Workspace内のOutcomeをIDで取得する。他WorkspaceのOutcome IDはnull（Execution向けの参照ポートが使う）。 */
  findByIdInWorkspace(workspaceId: string, outcomeId: string): Promise<Outcome | null>;
  /** Workspace内で、ProjectをTargetとするactiveなOutcomeをTarget設定の新しい順で返す（Project Role Contextが使う）。 */
  findActiveByTargetProject(workspaceId: string, projectId: string): Promise<Outcome[]>;
  /** activeなOutcomeのtitle・hypothesisだけを更新する。 */
  update(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    changes: UpdateOutcomeInput,
  ): Promise<ChangeOutcomeResult>;
  cancel(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    reason: string,
  ): Promise<ChangeOutcomeResult>;
}
