import type { IntentStatus } from "../model/Intent.ts";
import type { Outcome, OutcomeStatus } from "../model/Outcome.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";
import type { CreateOutcomeInput, UpdateOutcomeInput } from "../../shared/outcomeSchema.ts";

/** 作成の結果。Intentが無い場合と、activeでない場合を区別する。 */
export type CreateOutcomeResult =
  | { kind: "created"; outcome: Outcome }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | ProjectArchivedResult;

/** 更新・取消の結果。Intentが無い場合と、Outcomeが無い場合と、activeでない場合を区別する。 */
export type ChangeOutcomeResult =
  | { kind: "changed"; outcome: Outcome }
  | { kind: "intent_not_found" }
  | { kind: "outcome_not_found" }
  | { kind: "not_active"; status: OutcomeStatus }
  | ProjectArchivedResult;

/**
 * 成功条件はOutcomeの一部として作成・取得する。作成後に固定されるため、
 * Criterionを更新・削除するメソッドは意図的に持たない。
 */
export interface OutcomeRepository {
  /** Outcomeと全Success Criterionを1 transactionで保存する。activeなIntent配下にだけ作成できる。 */
  create(projectId: string, intentId: string, input: CreateOutcomeInput): Promise<CreateOutcomeResult>;
  /** 指定したProject・Intent配下のOutcomeを新しい順で、成功条件をposition順に含めて返す。 */
  findByIntent(projectId: string, intentId: string): Promise<Outcome[]>;
  /** 他ProjectまたはIntent配下のOutcome IDはnullとして扱う。 */
  findById(projectId: string, intentId: string, outcomeId: string): Promise<Outcome | null>;
  /** Intentを指定せず、Project内のOutcomeをIDで取得する。他ProjectのOutcome IDはnull（Execution向けの参照ポートが使う）。 */
  findByIdInProject(projectId: string, outcomeId: string): Promise<Outcome | null>;
  /** activeなOutcomeのtitle・hypothesisだけを更新する。 */
  update(
    projectId: string,
    intentId: string,
    outcomeId: string,
    changes: UpdateOutcomeInput,
  ): Promise<ChangeOutcomeResult>;
  cancel(
    projectId: string,
    intentId: string,
    outcomeId: string,
    reason: string,
  ): Promise<ChangeOutcomeResult>;
}
