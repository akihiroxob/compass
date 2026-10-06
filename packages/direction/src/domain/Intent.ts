export type IntentStatus = "active" | "achieved" | "abandoned";

export type IntentProperties = {
  id: string;
  workspaceId: string;
  title: string;
  desiredState: string;
  completionDefinition: string | null;
  status: IntentStatus;
  abandonedReason: string | null;
  createdAt: number;
  updatedAt: number;
};

export class Intent {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly desiredState: string;
  readonly completionDefinition: string | null;
  readonly status: IntentStatus;
  readonly abandonedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;

  constructor(properties: IntentProperties) {
    this.id = properties.id;
    this.workspaceId = properties.workspaceId;
    this.title = properties.title;
    this.desiredState = properties.desiredState;
    this.completionDefinition = properties.completionDefinition;
    this.status = properties.status;
    this.abandonedReason = properties.abandonedReason;
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
  }
}
