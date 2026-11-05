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
    this.originDecisionId = properties.originDecisionId;
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
  }
}
