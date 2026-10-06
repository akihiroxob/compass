import type { IntentStatus } from "./Intent.ts";
import type { DirectionDecision } from "./DirectionDecision.ts";
import type { IntentResearchSummary } from "./Research.ts";
import type { Outcome } from "./Outcome.ts";
import type { ResearchRequest } from "./Research.ts";
import type { ProjectArchivedResult } from "./ProjectArchivedResult.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";
import type { DirectionDecisionRecordType } from "./DirectionDecision.ts";
import type { CreateOutcomeInput } from "./OutcomeRepository.ts";

/** 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。 */
export type CreateDirectionDecisionInput = {
  type: DirectionDecisionRecordType;
  intentId: string;
  judgment: string;
  reason: string;
  options: string[];
  usedSyntheses: { synthesisId: string; version: number }[];
  usedFindingIds: string[];
  requestKey: string;
  runRef: string;
  research?: {
    question: string;
    scope: string;
    completionCondition: string;
    budgetTotal: number;
    deadlineAt: number | null;
  };
  evaluationId?: string;
};

export type DecideNextOutcomeInput = {
  outcome: CreateOutcomeInput;
  intentId: string;
  judgment: string;
  reason: string;
  options: string[];
  usedSyntheses: { synthesisId: string; version: number }[];
  usedFindingIds: string[];
  requestKey: string;
  runRef: string;
  evaluationId?: string;
};

export type InvalidResearchReferenceResult = {
  kind: "invalid_reference";
  reference: "synthesis" | "finding" | "evaluation";
  ids: string[];
};

/** 指定versionが、Synthesisの現在のversionと一致しない（supersedeされた・誤ったversion）。 */
export type SynthesisVersionMismatchResult = {
  kind: "synthesis_version_mismatch";
  synthesisId: string;
  expected: number;
  actual: number;
};

type DirectionDecisionWriteRejection =
  | { kind: "key_conflict"; requestKey: string }
  /** additional_researchの`research.deadlineAt`が判断時点で過去。再送の判定より後に検査する。 */
  | { kind: "deadline_in_past"; deadlineAt: number }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | InvalidResearchReferenceResult
  | SynthesisVersionMismatchResult
  /** `evaluationId`が、再評価で置き換えられた古い評価を指す。 */
  | { kind: "evaluation_not_latest"; evaluationId: string; latestEvaluationId: string }
  /** `evaluationId`の評価を根拠にしたDecisionが既にある（再計画・Intent完了の重複）。 */
  | { kind: "evaluation_already_decided"; evaluationId: string; decisionId: string }
  /** `evaluationId`の評価対象Outcomeが取消済み。 */
  | { kind: "evaluation_outcome_not_active"; outcomeId: string; status: string }
  /** intent_completeの根拠がachievedでない評価。 */
  | { kind: "evaluation_result_mismatch"; evaluationId: string; result: string }
  /** intent_completeの対象Intentに完了定義（completionDefinition）が無い。 */
  | { kind: "no_completion_definition" }
  | ProjectArchivedResult
  | (WorkspaceArchivedResult & { workspaceId: string });

/** `researchRequest`はadditional_researchのDecisionが同時に作ったRequest。他のtypeではnull。 */
export type CreateDirectionDecisionResult =
  | { kind: "created"; decision: DirectionDecision; researchRequest: ResearchRequest | null }
  | { kind: "replayed"; decision: DirectionDecision; researchRequest: ResearchRequest | null }
  | DirectionDecisionWriteRejection;

export type DecideNextOutcomeResult =
  | { kind: "created"; decision: DirectionDecision; outcome: Outcome }
  | { kind: "replayed"; decision: DirectionDecision; outcome: Outcome }
  | DirectionDecisionWriteRejection;

/**
 * Direction Decisionの永続化。作成後は変更しない（追記のみ）。書込はすべてProjectのarchived確認と
 * 同一transactionで行う。Intent完了・Outcome作成は所属Workspaceのarchivedも同じtransactionで確認する。
 * `intentBriefSnapshot`は呼び出し側（application層）がResearchRepositoryから
 * 読み取り、判断時点のsnapshotとしてそのまま保存する。
 */
export interface DirectionDecisionRepository {
  /**
   * next_outcome以外の5種の判断を記録する。同じrequestKeyの再送は新しい行を作らず既存のDecisionを返す。
   * additional_researchは、判断・Research Request・`research_requested`イベントを1 transactionで保存し、部分保存を許さない。
   * usedSyntheses・usedFindingIdsは同じProjectに存在し、指定versionが現在のSynthesis versionと一致する場合だけ受け付ける。
   * `evaluationId`は同じIntentの、最新で、まだ判断に使われていない評価だけを受け付ける。
   * intent_completeは完了定義を持つIntentに、achievedの評価を根拠にしてだけ記録でき、同じtransactionでIntentを`achieved`にする。
   */
  create(
    projectId: string,
    intentBriefSnapshot: IntentResearchSummary,
    input: CreateDirectionDecisionInput & { principalId: string },
  ): Promise<CreateDirectionDecisionResult>;
  /** next_outcome判断とOutcome（成功条件含む）を1 transactionで保存する。部分保存を許さない。 */
  decideNextOutcome(
    projectId: string,
    intentBriefSnapshot: IntentResearchSummary,
    input: DecideNextOutcomeInput & { principalId: string },
  ): Promise<DecideNextOutcomeResult>;
  /** 指定Intent配下のDecisionを新しい順に返す。 */
  findByIntent(projectId: string, intentId: string): Promise<DirectionDecision[]>;
}
