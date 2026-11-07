export type IntentStatus = "active" | "achieved" | "abandoned";

export type IntentProperties = {
  id: string;
  workspaceId: string;
  title: string;
  desiredState: string;
  /** 背景・理由。任意。 */
  background: string | null;
  /** 対象・範囲（誰・何に向けた目標か）。任意。 */
  audience: string | null;
  /** 守るべき制約。任意。 */
  constraints: string | null;
  /** 達成条件（何が示されれば完了と言えるか）。任意。 */
  completionDefinition: string | null;
  /** 目標日（`YYYY-MM-DD`の暦日）。任意。 */
  targetDate: string | null;
  status: IntentStatus;
  abandonedReason: string | null;
  /** 保存のたびに1ずつ増える版。作成時は1。 */
  version: number;
  /** 意味（desiredState / completionDefinition）が最後に変わった版。 */
  meaningVersion: number;
  createdAt: number;
  updatedAt: number;
};

/** Intentの版ごとの内容と、変更した主体・理由。古いOutcome・判断・評価は作成時の版をここで参照する。 */
export type IntentRevision = {
  intentId: string;
  workspaceId: string;
  version: number;
  title: string;
  desiredState: string;
  background: string | null;
  audience: string | null;
  constraints: string | null;
  completionDefinition: string | null;
  targetDate: string | null;
  /** この版でdesiredState / completionDefinitionが変わったか。 */
  meaningChanged: boolean;
  reason: string | null;
  changedBy: string;
  changedByRole: string;
  createdAt: number;
};

export class Intent {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly desiredState: string;
  readonly background: string | null;
  readonly audience: string | null;
  readonly constraints: string | null;
  readonly completionDefinition: string | null;
  readonly targetDate: string | null;
  readonly status: IntentStatus;
  readonly abandonedReason: string | null;
  readonly version: number;
  readonly meaningVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;

  constructor(properties: IntentProperties) {
    this.id = properties.id;
    this.workspaceId = properties.workspaceId;
    this.title = properties.title;
    this.desiredState = properties.desiredState;
    this.background = properties.background;
    this.audience = properties.audience;
    this.constraints = properties.constraints;
    this.completionDefinition = properties.completionDefinition;
    this.targetDate = properties.targetDate;
    this.status = properties.status;
    this.abandonedReason = properties.abandonedReason;
    this.version = properties.version;
    this.meaningVersion = properties.meaningVersion;
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
  }
}
