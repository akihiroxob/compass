export type ProjectRepositoryLink = {
  id: string;
  name: string;
  url: string;
};

export type ProjectResource = {
  id: string;
  name: string;
  url: string;
  kind: string | null;
};

export type ProjectStatus = "active" | "archived";

export type ProjectProperties = {
  id: string;
  workspaceId: string;
  name: string;
  /** Projectの目的（purpose）。 */
  description: string | null;
  repositories: ProjectRepositoryLink[];
  resources: ProjectResource[];
  createdAt: number;
  updatedAt: number;
  status: ProjectStatus;
  archivedAt: number | null;
  archiveReason: string | null;
};

/**
 * Workの実行境界（docs/adr/0001-workspace-project-boundary.md）。所属Workspaceの1つで、RepositoryはResourceの一つとして持つ。
 * Mission / Vision / Principles / ConstraintsはWorkspaceが正本で、Projectは持たない。
 */
export class Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly repositories: ProjectRepositoryLink[];
  readonly resources: ProjectResource[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: ProjectStatus;
  readonly archivedAt: number | null;
  readonly archiveReason: string | null;

  constructor(properties: ProjectProperties) {
    this.id = properties.id;
    this.workspaceId = properties.workspaceId;
    this.name = properties.name;
    this.description = properties.description;
    this.repositories = properties.repositories.map((item) => ({ ...item }));
    this.resources = properties.resources.map((item) => ({ ...item }));
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
    this.status = properties.status;
    this.archivedAt = properties.archivedAt;
    this.archiveReason = properties.archiveReason;
  }
}

/** 所属Workspaceが正本として持つ戦略値。 */
export type WorkspaceStrategy = {
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
};

/**
 * Projectの参照モデル。Projectの値に所属Workspaceの戦略値を合成し、既存の公開契約（Web API・MCP・Role Contextの
 * Projectの応答にMission等を含む形）を保つ。所属Workspace IDの公開はWorkspaceの参照契約（S02-04）で行うため含めない。
 */
export type ProjectDetail = Omit<ProjectProperties, "workspaceId"> & WorkspaceStrategy;
