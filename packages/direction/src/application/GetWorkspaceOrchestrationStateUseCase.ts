import type { ProjectDetail, Workspace } from "@compass/organization";
import { NotFoundError } from "@compass/shared";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { IntentStatus } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeStatus } from "../domain/Outcome.ts";
import { assessOutcomeEvaluability, attachTargetExecutions, type OutcomeEvaluability } from "../domain/OutcomeEvaluability.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { ExecutionState } from "../domain/OutcomeExecution.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { OutcomeTargetProjectRepository, OutcomeTargetProjectView } from "../domain/OutcomeTargetProject.ts";
import { isClosedResearchStatus } from "../domain/Research.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { toOrchestrationResearchRequest, type OrchestrationResearchRequest } from "./GetOrchestrationStateUseCase.ts";
import type { DirectionWorkspaceRuntimeAuthorizationPort } from "./port/DirectionAuthorizationPort.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ExecutionSummaryState, OutcomeWorkSummaryPort } from "./port/ExecutionSummaryPort.ts";

/** WorkspaceのactiveなProjectを読むport（Organizationが所有）。Organizationの`ProjectRepository`がこの形を満たす。 */
export interface WorkspaceOrchestrationProjectReader {
  findAllInWorkspace(workspaceId: string): Promise<Pick<ProjectDetail, "id" | "name" | "status" | "createdAt">[]>;
}

/**
 * OutcomeのTarget 1件の現在状態。archivedのProjectも`projectStatus`付きで残す（未完了のarchived Targetを識別するため）。
 * - `work`: そのProjectでOutcomeに相関付いたStory / Taskの件数。Storyが無ければnull（そのProjectは未分解）
 * - `execution`: そのProjectからOutcomeへ還流済みのExecution要約。未還流はnull
 */
export type WorkspaceOrchestrationTarget = {
  projectId: string;
  projectStatus: OutcomeTargetProjectView["projectStatus"];
  work: { state: ExecutionSummaryState; storyCount: number; taskCount: number } | null;
  execution: { state: ExecutionState; executionCursor: number } | null;
};

export type WorkspaceOrchestrationOutcome = {
  id: string;
  status: OutcomeStatus;
  updatedAt: number;
  /** 現在のTarget（設定順）。空ならTargetなし。 */
  targets: WorkspaceOrchestrationTarget[];
  /** 全Targetから見た評価可能性。`replan_required`は未完了のarchived Targetを持つ（Project ID・状態・理由だけ）。 */
  evaluability: OutcomeEvaluability;
  /**
   * 最新のEvaluationと、それを根拠にしたDirection Decision（未判断はnull）。`targets`は評価snapshotにあった
   * Project別のExecution cursorで、現在の`targets[].execution.executionCursor`と比べて未評価の還流を判定できる。
   */
  latestEvaluation: {
    id: string;
    decisionId: string | null;
    createdAt: number;
    targets: { projectId: string; executionCursor: number }[];
  } | null;
};

/**
 * Orchestratorが専門Roleの起動を判断するための、1 Workspaceの現在状態（handoff v2「19」）。本文（Mission・Intent・Outcomeの内容・
 * Research本文・Story / Task）は含めず、ID・状態・件数だけを返す。何をどう判断するかは起動されたRoleがRole Contextから取得する。
 * archivedのWorkspaceは状態だけを返し、Intent・Outcome・Research・Projectを空にする。archivedのProjectは`projects`から除き、
 * Targetとしてだけ`projectStatus: "archived"`で現れる。
 */
export type WorkspaceOrchestrationState = {
  workspace: Pick<Workspace, "id" | "name" | "status">;
  /** WorkspaceのactiveなProject（作成順）。 */
  projects: { id: string; name: string }[];
  activeIntent: { id: string; status: IntentStatus; updatedAt: number } | null;
  /** Active Intent配下の全状態のOutcome（新しい順）。Active Intentが無ければ空。 */
  outcomes: WorkspaceOrchestrationOutcome[];
  /** Active Intentを発端とする全状態のResearch Request（新しい順）。Active Intentが無ければ空。 */
  intentResearchRequests: OrchestrationResearchRequest[];
  /** Workspace内の未終了（requested / running）のResearch Request。発端Intentを問わない（新しい順）。 */
  openResearchRequests: OrchestrationResearchRequest[];
  observedAt: number;
};

/**
 * 外部Orchestrator向けのWorkspace単位の現在状態Query。Direction自身のrecordと、Workの件数（`OutcomeWorkSummaryPort`）だけを読み、
 * 書込はしない。Activity・Runtime eventのcursorには依存しない（同じ状態からは同じ応答になる）。
 * Work・Target・Evaluationは件数によらず一定回数で読み、Execution要約だけOutcomeごとに読む。
 */
export class GetWorkspaceOrchestrationStateUseCase<TCaller> {
  constructor(
    private readonly authorization: DirectionWorkspaceRuntimeAuthorizationPort<TCaller>,
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly projectReader: WorkspaceOrchestrationProjectReader,
    private readonly intentRepository: Pick<IntentRepository, "findByWorkspace">,
    private readonly outcomeRepository: Pick<OutcomeRepository, "findByIntent">,
    private readonly researchRepository: Pick<ResearchRepository, "findRequests">,
    private readonly directionDecisionRepository: Pick<DirectionDecisionRepository, "findByIntent">,
    private readonly outcomeEvaluationRepository: Pick<OutcomeEvaluationRepository, "findLatestByIntent">,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByIntent">,
    private readonly outcomeExecutionRepository: Pick<OutcomeExecutionRepository, "findByOutcome">,
    private readonly workSummary: OutcomeWorkSummaryPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(caller: TCaller, workspaceId: string): Promise<WorkspaceOrchestrationState> {
    // 認可はWorkspaceの存在確認より先。scopeの無い呼出しへWorkspaceの存在有無を漏らさない。
    await this.authorization.requireWorkspaceScope(caller, workspaceId, "runtime:state:read");
    const workspace = await this.workspaceReader.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    const empty = {
      workspace: { id: workspace.id, name: workspace.name, status: workspace.status },
      projects: [],
      activeIntent: null,
      outcomes: [],
      intentResearchRequests: [],
      openResearchRequests: [],
      observedAt: this.clock(),
    };
    if (workspace.status !== "active") return empty;

    const projects = (await this.projectReader.findAllInWorkspace(workspaceId))
      .filter((project) => project.status === "active")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, name }) => ({ id, name }));
    const requests = await this.researchRepository.findRequests(workspaceId);
    const base = {
      ...empty,
      projects,
      openResearchRequests: requests.filter((request) => !isClosedResearchStatus(request.status)).map(toOrchestrationResearchRequest),
    };
    const activeIntent = (await this.intentRepository.findByWorkspace(workspaceId)).find((intent) => intent.status === "active");
    if (!activeIntent) return base;

    const decisions = await this.directionDecisionRepository.findByIntent(workspaceId, activeIntent.id);
    const decidedBy = new Map(
      decisions.filter((decision) => decision.evaluationId !== null).map((decision) => [decision.evaluationId, decision.id]),
    );
    const latestEvaluations = new Map(
      (await this.outcomeEvaluationRepository.findLatestByIntent(workspaceId, activeIntent.id)).map((evaluation) => [
        evaluation.outcomeId,
        evaluation,
      ]),
    );
    const targets = await this.targetRepository.listByIntent(workspaceId, activeIntent.id);
    const key = (outcomeId: string, projectId: string) => JSON.stringify([outcomeId, projectId]);
    const works = new Map(
      (await this.workSummary.summarizeOutcomeProjects(targets.map(({ outcomeId, projectId }) => ({ outcomeId, projectId })))).map(
        ({ outcomeId, projectId, state, storyCount, taskCounts }) => [
          key(outcomeId, projectId),
          { state, storyCount, taskCount: Object.values(taskCounts).reduce((total, count) => total + count, 0) },
        ],
      ),
    );

    const outcomes: WorkspaceOrchestrationOutcome[] = [];
    for (const outcome of await this.outcomeRepository.findByIntent(workspaceId, activeIntent.id)) {
      const outcomeTargets = targets.filter((target) => target.outcomeId === outcome.id);
      const executions = attachTargetExecutions(
        outcomeTargets,
        await this.outcomeExecutionRepository.findByOutcome(workspaceId, outcome.id),
      ).targets;
      const evaluation = latestEvaluations.get(outcome.id);
      outcomes.push({
        id: outcome.id,
        status: outcome.status,
        updatedAt: outcome.updatedAt,
        targets: executions.map(({ projectId, projectStatus, execution }) => ({
          projectId,
          projectStatus,
          work: works.get(key(outcome.id, projectId)) ?? null,
          execution: execution
            ? { state: execution.summary.state, executionCursor: execution.summary.executionCursor }
            : null,
        })),
        evaluability: assessOutcomeEvaluability(executions),
        latestEvaluation: evaluation
          ? {
              id: evaluation.id,
              decisionId: decidedBy.get(evaluation.id) ?? null,
              createdAt: evaluation.createdAt,
              targets: evaluation.snapshot.targets.map(({ projectId, execution }) => ({
                projectId,
                executionCursor: execution.executionCursor,
              })),
            }
          : null,
      });
    }
    return {
      ...base,
      activeIntent: { id: activeIntent.id, status: activeIntent.status, updatedAt: activeIntent.updatedAt },
      outcomes,
      intentResearchRequests: requests
        .filter((request) => request.originIntentId === activeIntent.id)
        .map(toOrchestrationResearchRequest),
    };
  }
}
