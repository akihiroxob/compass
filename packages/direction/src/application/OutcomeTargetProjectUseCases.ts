import type {
  OutcomeTargetProject,
  OutcomeTargetProjectRepository,
  OutcomeTargetProjectView,
} from "../domain/OutcomeTargetProject.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { ProjectArchivedError, WorkspaceArchivedError } from "@compass/organization";

const requireWorkspace = async (workspaceReader: DirectionWorkspaceReader, workspaceId: string) => {
  if (!(await workspaceReader.findById(workspaceId))) {
    throw new NotFoundError(`Workspace ${workspaceId} was not found`);
  }
};

/** 追加・解除で共通する拒否を、公開する業務エラーへ変換する。 */
const rejectCommon = (
  result:
    | { kind: "outcome_not_found" }
    | { kind: "outcome_not_active"; status: string }
    | { kind: "project_not_found" }
    | { kind: "workspace_archived" },
  workspaceId: string,
  outcomeId: string,
  projectId: string,
): never => {
  switch (result.kind) {
    case "workspace_archived":
      throw new WorkspaceArchivedError(workspaceId);
    case "outcome_not_found":
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    case "outcome_not_active":
      throw new ConflictError(`Outcome ${outcomeId} is ${result.status} and its Target Projects cannot be changed`, {
        status: result.status,
      });
    case "project_not_found":
      throw new NotFoundError(`Project ${projectId} was not found in Workspace ${workspaceId}`);
  }
};

/** activeなOutcomeへ、同じWorkspaceのactiveなProjectをTargetとして追加する（Strategistの判断）。 */
export class SetOutcomeTargetProjectUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly targetRepository: OutcomeTargetProjectRepository,
  ) {}

  async execute(workspaceId: string, outcomeId: string, projectId: string): Promise<OutcomeTargetProject> {
    await requireWorkspace(this.workspaceReader, workspaceId);
    const result = await this.targetRepository.add(workspaceId, outcomeId, projectId);
    if (result.kind === "added") return result.target;
    if (result.kind === "project_archived") {
      throw new ProjectArchivedError(projectId, `Project ${projectId} is archived and cannot become a Target Project`);
    }
    if (result.kind === "already_target") {
      throw new ConflictError(`Project ${projectId} is already a Target Project of Outcome ${outcomeId}`, {
        reason: "already_target",
      });
    }
    return rejectCommon(result, workspaceId, outcomeId, projectId);
  }
}

/**
 * activeなOutcomeからTargetを解除する。archivedのProjectも解除できる。既存Story・成果・Evidenceの参照は変えない。
 */
export class UnsetOutcomeTargetProjectUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly targetRepository: OutcomeTargetProjectRepository,
  ) {}

  async execute(workspaceId: string, outcomeId: string, projectId: string): Promise<OutcomeTargetProject> {
    await requireWorkspace(this.workspaceReader, workspaceId);
    const result = await this.targetRepository.remove(workspaceId, outcomeId, projectId);
    if (result.kind === "removed") return result.target;
    if (result.kind === "not_target") {
      throw new NotFoundError(`Project ${projectId} is not a Target Project of Outcome ${outcomeId}`);
    }
    return rejectCommon(result, workspaceId, outcomeId, projectId);
  }
}

/** OutcomeのTargetを設定順で返す。Targetなしは空配列。archivedのWorkspace・Outcomeも参照できる。 */
export class ListOutcomeTargetProjectsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly targetRepository: OutcomeTargetProjectRepository,
  ) {}

  async execute(workspaceId: string, outcomeId: string): Promise<OutcomeTargetProjectView[]> {
    await requireWorkspace(this.workspaceReader, workspaceId);
    const targets = await this.targetRepository.listByOutcome(workspaceId, outcomeId);
    if (!targets) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    return targets;
  }
}
