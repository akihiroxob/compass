import type { Project } from "../model/Project.ts";
import type { CreateProjectInput } from "../../shared/projectSchema.ts";

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findAll(): Promise<Project[]>;
  findById(projectId: string): Promise<Project | null>;
}
