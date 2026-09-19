import type { Generated } from "kysely";

export type ProjectTable = {
  id: string;
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  created_at: number;
  updated_at: number;
};

type OrderedTextTable = {
  id: string;
  project_id: string;
  value: string;
  sort_order: number;
};

export type ProjectRepositoryLinkTable = {
  id: string;
  project_id: string;
  name: string;
  url: string;
  sort_order: number;
};

export type ProjectResourceTable = ProjectRepositoryLinkTable & {
  kind: string | null;
};

export type Database = {
  project: ProjectTable;
  project_principle: OrderedTextTable;
  project_constraint: OrderedTextTable;
  project_repository_link: ProjectRepositoryLinkTable;
  project_resource: ProjectResourceTable;
};

export type DatabaseMetadata = Generated<number>;
