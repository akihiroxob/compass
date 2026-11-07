/**
 * `evaluating` / `achieved` / `not_achieved` は後続（Evaluation）のために予約した値で、
 * Step 3のアプリケーション層は`active`と`cancelled`だけを書き込む。
 */
export type OutcomeStatus = "active" | "evaluating" | "achieved" | "not_achieved" | "cancelled";

export type SuccessCriterion = {
  id: string;
  outcomeId: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
};

/**
 * 課題の根拠の状態。`insufficient`は根拠不足、`observed`は観測した事実がある、`refuted`は観測が課題の存在を否定する（反証）。
 * 観測は原因の確定を意味しない。原因は常に`causeHypothesis`（仮説）として別に持ち、確定状態は持たない。
 */
export const problemEvidenceStatuses = ["insufficient", "observed", "refuted"] as const;

export type ProblemEvidenceStatus = (typeof problemEvidenceStatuses)[number];

/**
 * 評価方法。`cognitive_walkthrough`は設計の点検で、実ユーザーの使いやすさ・価値の証拠ではない。
 * A/B・差分の差分法は候補で、適用前提（`premises`）を計画へ記す。統計解析はCompassでは行わない。
 */
export const evaluationMethods = ["cognitive_walkthrough", "quantitative_observation", "ab_test", "difference_in_differences", "other"] as const;

export type EvaluationMethod = (typeof evaluationMethods)[number];

/** 因果の主張に適用前提の確認が要る方法。 */
export const causalEvaluationMethods: readonly EvaluationMethod[] = ["ab_test", "difference_in_differences"];

/**
 * 課題・解決策の仮説に付ける評価計画。計画は実施の記録ではなく、実施状況は結果（Outcome Evaluation）の有無で決まる。
 */
export type EvaluationPlan = {
  /** 確かめたい問い。 */
  question: string;
  method: EvaluationMethod;
  /** 評価方法の適用前提（無作為割付・比較群・介入前の推移等）。 */
  premises: string | null;
  /** 観測期間。 */
  observationPeriod: string | null;
  /** 判断条件と中止条件。 */
  decisionCriteria: string;
  stopCriteria: string | null;
};

/** 根拠として参照できるResearchの記録。本文は複製せず、同じWorkspaceのFinding・最新版のSynthesisをIDで参照する。 */
export const problemEvidenceKinds = ["research_finding", "research_synthesis"] as const;

export type ProblemEvidenceKind = (typeof problemEvidenceKinds)[number];

/** 課題の根拠参照。`requestId`・`summary`は読取時に参照先から解決した値で、Outcome側には保存しない。 */
export type ProblemEvidence = {
  kind: ProblemEvidenceKind;
  id: string;
  requestId: string;
  /** Findingのstatement、またはSynthesisのconclusion。 */
  summary: string;
  /** Synthesisが後の版に置き換えられた場合true（関連付け後に更新されたことを示す）。Findingは常にfalse。 */
  superseded: boolean;
};

/**
 * Outcomeの変化を妨げる課題（Problem Statement）と、その根拠・解決策の仮説。Outcomeの一部として保存し、独立した承認工程を持たない。
 * 開発上の障害（Taskの停止・差戻し等）は含めない。
 */
export type OutcomeProblem = {
  id: string;
  outcomeId: string;
  position: number;
  statement: string;
  evidenceStatus: ProblemEvidenceStatus;
  /** 観測した事実。原因の解釈は含めない。 */
  observation: string | null;
  /** 原因の仮説。観測から確定したものとして扱わない。 */
  causeHypothesis: string | null;
  /** 解決策の仮説。 */
  solutionHypothesis: string | null;
  /** 評価計画。未記録はnull。 */
  evaluationPlan: EvaluationPlan | null;
  evidence: ProblemEvidence[];
};

export type OutcomeProperties = {
  id: string;
  workspaceId: string;
  intentId: string;
  /** 作成または最後に再確認した時点のIntentの版。Intentの`meaningVersion`より古い未完了のOutcomeは再計画の対象。 */
  intentVersion: number;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: OutcomeStatus;
  cancelReason: string | null;
  successCriteria: SuccessCriterion[];
  problems: OutcomeProblem[];
  /** 更新のたびに1増える版。古い版を前提にした更新を拒否するために使う（作成時は1）。 */
  revision: number;
  /** このOutcomeを判断したDirection DecisionのID。Decision導入前・Decisionを経由しない作成はnull。 */
  originDecisionId: string | null;
  createdAt: number;
  updatedAt: number;
};

export class Outcome {
  readonly id: string;
  readonly workspaceId: string;
  readonly intentId: string;
  readonly intentVersion: number;
  readonly title: string;
  readonly description: string;
  readonly hypothesis: string | null;
  readonly rationale: string;
  readonly status: OutcomeStatus;
  readonly cancelReason: string | null;
  readonly successCriteria: readonly SuccessCriterion[];
  readonly problems: readonly OutcomeProblem[];
  readonly revision: number;
  readonly originDecisionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;

  constructor(properties: OutcomeProperties) {
    this.id = properties.id;
    this.workspaceId = properties.workspaceId;
    this.intentId = properties.intentId;
    this.intentVersion = properties.intentVersion;
    this.title = properties.title;
    this.description = properties.description;
    this.hypothesis = properties.hypothesis;
    this.rationale = properties.rationale;
    this.status = properties.status;
    this.cancelReason = properties.cancelReason;
    this.successCriteria = properties.successCriteria;
    this.problems = properties.problems;
    this.revision = properties.revision;
    this.originDecisionId = properties.originDecisionId;
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
  }
}
