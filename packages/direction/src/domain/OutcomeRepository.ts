import type { IntentStatus } from "./Intent.ts";
import type { EvaluationPlan, Outcome, OutcomeStatus, ProblemEvidenceKind, ProblemEvidenceStatus } from "./Outcome.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/** 課題の入力。`id`を指定すると同じOutcomeの既存の課題を引き継ぎ、未指定は新しい課題になる。 */
export type OutcomeProblemInput = {
  id?: string | undefined;
  statement: string;
  evidenceStatus: ProblemEvidenceStatus;
  observation: string | null;
  causeHypothesis: string | null;
  solutionHypothesis: string | null;
  evaluationPlan: EvaluationPlan | null;
  evidence: { kind: ProblemEvidenceKind; id: string }[];
};

/** 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。 */
export type CreateOutcomeInput = {
  /** 判断の元にしたIntentの版（必須）。現在版との一致を条件にし、古い版の判断は競合にする。 */
  intentVersion: number;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  successCriteria: { description: string; measurement: string; target: string | null }[];
  problems: OutcomeProblemInput[];
};

export type UpdateOutcomeInput = {
  /** Intentの現在版を確認したことを記録する。指定した場合は現在版との一致を条件にし、再計画の対象から外す。 */
  intentVersion?: number;
  title?: string;
  hypothesis?: string | null;
  /** 指定すると課題の一覧全体を置き換える。 */
  problems?: OutcomeProblemInput[];
  /** 更新の前提にした版。指定した場合、現在の版と異なれば更新しない。 */
  expectedRevision?: number;
};

/** 作成の結果。Intentが無い場合と、activeでない場合を区別する。 */
export type CreateOutcomeResult =
  | { kind: "created"; outcome: Outcome }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | { kind: "intent_version_conflict"; currentVersion: number }
  | WorkspaceArchivedResult;

/** 更新・取消の結果。Intentが無い場合と、Outcomeが無い場合と、activeでない場合を区別する。 */
export type ChangeOutcomeResult =
  | { kind: "changed"; outcome: Outcome }
  | { kind: "intent_not_found" }
  | { kind: "outcome_not_found" }
  | { kind: "not_active"; status: OutcomeStatus }
  | { kind: "stale_revision"; currentRevision: number }
  | WorkspaceArchivedResult;

/** 更新の結果。`intentVersion`を指定して確認した版が現在版と異なる場合を加える。 */
export type UpdateOutcomeResult = ChangeOutcomeResult | { kind: "intent_version_conflict"; currentVersion: number };

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
  /** activeなOutcomeのtitle・hypothesis・課題だけを更新し、版を1増やす。成功条件・Target Projectは変更しない。 */
  update(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    changes: UpdateOutcomeInput,
  ): Promise<UpdateOutcomeResult>;
  cancel(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    reason: string,
  ): Promise<Exclude<ChangeOutcomeResult, { kind: "stale_revision" }>>;
}
