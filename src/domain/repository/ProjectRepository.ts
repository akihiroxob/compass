import type { Project } from "../model/Project.ts";
import type { CreateProjectInput, UpdateProjectInput } from "../../shared/projectSchema.ts";

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  /** 指定したProjectがなければnull。親と子要素は同一transactionで更新する。 */
  update(projectId: string, input: UpdateProjectInput): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  findById(projectId: string): Promise<Project | null>;
  exists(projectId: string): Promise<boolean>;
}
