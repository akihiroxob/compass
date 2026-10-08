import type {
  OutcomeTargetProject,
  OutcomeTargetProjectRepository,
  OutcomeTargetProjectView,
} from "../domain/OutcomeTargetProject.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { OutcomeProjectWorkSummary, OutcomeWorkSummaryPort } from "./port/ExecutionSummaryPort.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { OutcomeStatus } from "../domain/Outcome.ts";
import type { OutcomeExecutionRecord } from "../domain/OutcomeExecution.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
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

/** Target 1件と、そのProjectでOutcomeに相関付いたWorkの要約。Storyが無ければ`work`はnull。 */
export type OutcomeTargetWork = OutcomeTargetProjectView & {
  work: Pick<OutcomeProjectWorkSummary, "state" | "storyCount" | "taskCounts"> | null;
};

/**
 * OutcomeごとのTarget別Work。`targets`が空ならTargetなし（Strategistの判断待ち）、`work`がnullのTargetは
 * そのProjectにStoryが無い（そのProjectのManagerの計画待ち）。Story / Task本文はWorkが正本で、ここへ複製しない。
 */
export type OutcomeTargetWorkSummary = {
  outcomeId: string;
  outcomeStatus: OutcomeStatus;
  targets: OutcomeTargetWork[];
};

/**
 * Intent配下の全OutcomeのTarget別Work要約（表示・dispatchの入力）。Outcome・Target・Workをそれぞれ一定回数で読み、
 * Outcome数・Target数に比例した読取をしない。WorkはTargetの組（Outcome・Project）だけを数え、Target外のProjectのStoryは含めない。
 */
export class ListOutcomeTargetWorkUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: Pick<IntentRepository, "findById">,
    private readonly outcomeRepository: Pick<OutcomeRepository, "findByIntent">,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByIntent">,
    private readonly workSummary: OutcomeWorkSummaryPort,
  ) {}

  /** Outcomeは新しい順、Targetは設定順。 */
  async execute(workspaceId: string, intentId: string): Promise<OutcomeTargetWorkSummary[]> {
    await requireWorkspace(this.workspaceReader, workspaceId);
    if (!(await this.intentRepository.findById(workspaceId, intentId))) {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    const outcomes = await this.outcomeRepository.findByIntent(workspaceId, intentId);
    const targets = await this.targetRepository.listByIntent(workspaceId, intentId);
    const key = (outcomeId: string, projectId: string) => JSON.stringify([outcomeId, projectId]);
    const works = new Map(
      (await this.workSummary.summarizeOutcomeProjects(targets.map(({ outcomeId, projectId }) => ({ outcomeId, projectId }))))
        .map(({ outcomeId, projectId, state, storyCount, taskCounts }) => [key(outcomeId, projectId), { state, storyCount, taskCounts }]),
    );
    return outcomes.map((outcome) => ({
      outcomeId: outcome.id,
      outcomeStatus: outcome.status,
      targets: targets
        .filter((target) => target.outcomeId === outcome.id)
        .map((target) => ({ ...target, work: works.get(key(target.outcomeId, target.projectId)) ?? null })),
    }));
  }
}

/** Target 1件と、そのProjectからOutcomeへ還流済みのExecution Summary・Evidence参照。未還流なら`execution`はnull。 */
export type OutcomeTargetExecution = OutcomeTargetProjectView & { execution: OutcomeExecutionRecord | null };

/**
 * OutcomeへのExecutionの還流をTarget Projectごとに集約した読取モデル。Summary・EvidenceはProject別のまま並べ、
 * 別ProjectのEvidenceや受入状況を合算しない。`nonTargetExecutions`はTarget解除前に還流された記録で、
 * 参照は保持するがTargetの集約には含めない。Evidence本文・Story / Task本文は含まない。
 */
export type OutcomeTargetExecutions = {
  outcomeId: string;
  outcomeStatus: OutcomeStatus;
  targets: OutcomeTargetExecution[];
  nonTargetExecutions: OutcomeExecutionRecord[];
};

/** OutcomeのTarget別のExecution Summary・Evidence（Workspaceの参照権限で読む）。archivedのProject・Outcomeも参照できる。 */
export class ListOutcomeTargetExecutionsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly outcomeRepository: Pick<OutcomeRepository, "findByIdInWorkspace">,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByOutcome">,
    private readonly executionRepository: Pick<OutcomeExecutionRepository, "findByOutcome">,
  ) {}

  /** Targetは設定順、`nonTargetExecutions`はProject ID順。 */
  async execute(workspaceId: string, outcomeId: string): Promise<OutcomeTargetExecutions> {
    await requireWorkspace(this.workspaceReader, workspaceId);
    const outcome = await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId);
    const targets = await this.targetRepository.listByOutcome(workspaceId, outcomeId);
    if (!outcome || !targets) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    const records = new Map(
      (await this.executionRepository.findByOutcome(workspaceId, outcomeId)).map((record) => [record.summary.projectId, record]),
    );
    const targetProjectIds = new Set(targets.map((target) => target.projectId));
    return {
      outcomeId,
      outcomeStatus: outcome.status,
      targets: targets.map((target) => ({ ...target, execution: records.get(target.projectId) ?? null })),
      nonTargetExecutions: [...records.values()].filter((record) => !targetProjectIds.has(record.summary.projectId)),
    };
  }
}
