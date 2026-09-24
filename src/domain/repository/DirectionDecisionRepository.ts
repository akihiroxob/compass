import type { IntentStatus } from "../model/Intent.ts";
import type { DirectionDecision } from "../model/DirectionDecision.ts";
import type { IntentResearchSummary } from "../model/Research.ts";
import type { Outcome } from "../model/Outcome.ts";
import type { ResearchRequest } from "../model/Research.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";
import type {
  CreateDirectionDecisionInput,
  DecideNextOutcomeInput,
} from "../../shared/directionDecisionSchema.ts";

export type InvalidResearchReferenceResult = {
  kind: "invalid_reference";
  reference: "synthesis" | "finding";
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
  | ProjectArchivedResult;

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
 * 同一transactionで行う。`intentBriefSnapshot`は呼び出し側（application層）がResearchRepositoryから
 * 読み取り、判断時点のsnapshotとしてそのまま保存する。
 */
export interface DirectionDecisionRepository {
  /**
   * next_outcome以外の5種の判断を記録する。同じrequestKeyの再送は新しい行を作らず既存のDecisionを返す。
   * additional_researchは、判断・Research Request・`research_requested`イベントを1 transactionで保存し、部分保存を許さない。
   * usedSyntheses・usedFindingIdsは同じProjectに存在し、指定versionが現在のSynthesis versionと一致する場合だけ受け付ける。
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
