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
  projectId: string;
  intentId: string;
  title: string;
  description: string;
  hypothesis: string | null;
  rationale: string;
  status: OutcomeStatus;
  cancelReason: string | null;
  successCriteria: SuccessCriterion[];
  createdAt: number;
  updatedAt: number;
};

export class Outcome {
  readonly id: string;
  readonly projectId: string;
  readonly intentId: string;
  readonly title: string;
  readonly description: string;
  readonly hypothesis: string | null;
  readonly rationale: string;
  readonly status: OutcomeStatus;
  readonly cancelReason: string | null;
  readonly successCriteria: readonly SuccessCriterion[];
  readonly createdAt: number;
  readonly updatedAt: number;

  constructor(properties: OutcomeProperties) {
    this.id = properties.id;
    this.projectId = properties.projectId;
    this.intentId = properties.intentId;
    this.title = properties.title;
    this.description = properties.description;
    this.hypothesis = properties.hypothesis;
    this.rationale = properties.rationale;
    this.status = properties.status;
    this.cancelReason = properties.cancelReason;
    this.successCriteria = properties.successCriteria;
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
  }
}
