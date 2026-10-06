export type WorkspaceStatus = "active" | "archived";

export type WorkspaceProperties = {
  id: string;
  name: string;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
  createdAt: number;
  updatedAt: number;
  status: WorkspaceStatus;
  archivedAt: number | null;
  archiveReason: string | null;
};

/**
 * Mission / Visionを共有し、複数Projectで成果を実現する戦略単位（docs/adr/0001-workspace-project-boundary.md）。
 * Projectを入れるUIフォルダやGitHub Organizationではない。
 */
export class Workspace {
  readonly id: string;
  readonly name: string;
  readonly mission: string;
  readonly vision: string | null;
  readonly principles: string[];
  readonly constraints: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: WorkspaceStatus;
  readonly archivedAt: number | null;
  readonly archiveReason: string | null;

  constructor(properties: WorkspaceProperties) {
    this.id = properties.id;
    this.name = properties.name;
    this.mission = properties.mission;
    this.vision = properties.vision;
    this.principles = [...properties.principles];
    this.constraints = [...properties.constraints];
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
    this.status = properties.status;
    this.archivedAt = properties.archivedAt;
    this.archiveReason = properties.archiveReason;
  }
}
