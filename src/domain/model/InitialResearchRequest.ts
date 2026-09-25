import type { CreateResearchRequestInput } from "../../shared/researchSchema.ts";

/** Initial Requestの予算。単位はRuntimeが定める抽象量で、Strategistの追加Requestや運用で調整する。 */
export const initialResearchBudget = 100;

/** 同じIntentからは常に同じkeyになる。これがDBのunique indexと合わさり、再送・復旧・schema再初期化で重複を防ぐ。 */
export const initialResearchRequestKey = (intentId: string): string => `initial-research:${intentId}`;

type IntentSnapshot = {
  readonly id: string;
  readonly title: string;
};

/**
 * Active Intent作成時に自動作成するDecision Research Requestの内容。
 * Intentの本文（desiredState / completionDefinition）は複製せず、発端Intentとして参照する
 * （Researcherは`get_researcher_context`で発端Intentを取得する）。deadlineはCompassが期限管理をしないため置かない。
 */
export const buildInitialResearchRequest = (intent: IntentSnapshot): CreateResearchRequestInput => ({
  requestKey: initialResearchRequestKey(intent.id),
  kind: "decision",
  originIntentId: intent.id,
  originOutcomeId: null,
  question: `Intent「${intent.title}」を実現する最初のOutcomeを決めるために、何を知る必要があり、何が既に分かっているか。`,
  scope:
    "発端Intentの目的と完了の定義、およびProjectのMission・Principles・Constraintsの範囲内。範囲外の調査は派生Questionとして分ける。",
  completionCondition:
    "Strategistが最初のOutcomeまたは追加Researchを決められる根拠が揃う（completed）。既存知識だけで判断できるならnot_needed、証拠を集め切れないならinsufficientを理由付きで確定する。",
  budgetTotal: initialResearchBudget,
  deadlineAt: null,
  correlationId: `intent:${intent.id}`,
});
