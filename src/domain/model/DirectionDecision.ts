import type { IntentResearchSummary } from "./Research.ts";

/** `next_outcome`はOutcomeと同一transactionで保存する（decideNextOutcome）。それ以外は判断だけを記録する。 */
export const directionDecisionRecordTypes = [
  "additional_research",
  "intent_complete",
  "intent_abandon",
  "policy_proposal",
  "adr_candidate",
] as const;

export type DirectionDecisionRecordType = (typeof directionDecisionRecordTypes)[number];

export const directionDecisionTypes = ["next_outcome", ...directionDecisionRecordTypes] as const;

export type DirectionDecisionType = (typeof directionDecisionTypes)[number];

/** 判断に使ったSynthesisのID・version。Findingはversionを持たないためIDだけをusedFindingIdsで別途保持する。 */
export type UsedSynthesisReference = {
  readonly synthesisId: string;
  readonly version: number;
};

/**
 * Compassを正本とするDirection Decision。判断・理由・選択肢・使用した根拠と、判断時点のIntent Brief snapshotを保持する。
 * 作成後は変更しない（追記のみ）。`outcomeId`は`next_outcome`のときだけ設定される。
 */
export type DirectionDecision = {
  readonly id: string;
  readonly projectId: string;
  readonly intentId: string;
  readonly outcomeId: string | null;
  readonly type: DirectionDecisionType;
  readonly judgment: string;
  readonly reason: string;
  readonly options: readonly string[];
  readonly usedSyntheses: readonly UsedSynthesisReference[];
  readonly usedFindingIds: readonly string[];
  readonly principalId: string;
  readonly runRef: string;
  readonly intentBriefSnapshot: IntentResearchSummary;
  readonly requestKey: string;
  readonly createdAt: number;
};
