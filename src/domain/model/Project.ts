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

export type ProjectProperties = {
  id: string;
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
  repositories: ProjectRepositoryLink[];
  resources: ProjectResource[];
  createdAt: number;
  updatedAt: number;
};

export class Project {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly mission: string;
  readonly vision: string | null;
  readonly principles: string[];
  readonly constraints: string[];
  readonly repositories: ProjectRepositoryLink[];
  readonly resources: ProjectResource[];
  readonly createdAt: number;
  readonly updatedAt: number;

  constructor(properties: ProjectProperties) {
    this.id = properties.id;
    this.name = properties.name;
    this.description = properties.description;
    this.mission = properties.mission;
    this.vision = properties.vision;
    this.principles = [...properties.principles];
    this.constraints = [...properties.constraints];
    this.repositories = properties.repositories.map((item) => ({ ...item }));
    this.resources = properties.resources.map((item) => ({ ...item }));
    this.createdAt = properties.createdAt;
    this.updatedAt = properties.updatedAt;
  }
}
