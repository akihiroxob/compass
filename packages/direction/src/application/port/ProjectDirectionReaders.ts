import type { Intent } from "../../domain/Intent.ts";
import type { Outcome } from "../../domain/Outcome.ts";

/** S03-04までのProject参照経路。serverが所属Workspaceを明示解決し、共有Workspaceは拒否する。 */
export interface ProjectIntentReader {
  findByProject(projectId: string): Promise<Intent[]>;
  findById(projectId: string, intentId: string): Promise<Intent | null>;
}

export interface ProjectOutcomeReader {
  findByIntent(projectId: string, intentId: string): Promise<Outcome[]>;
}
