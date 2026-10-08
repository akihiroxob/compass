import type { ExecutionState } from "../domain/OutcomeExecution.ts";
import type { OutcomeStatus } from "../domain/Outcome.ts";
import type { IntentStatus } from "../domain/Intent.ts";
import type { ProjectStatus } from "@compass/organization";
import type { ResearchRequestKind, ResearchRequestStatus } from "../domain/Research.ts";
import type { ProjectIntentReader } from "./port/ProjectDirectionReaders.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import type { ProjectOutcomeReader } from "./port/ProjectDirectionReaders.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { isClosedResearchStatus } from "../domain/Research.ts";
import { NotFoundError } from "@compass/shared";
import type { DirectionRuntimeAuthorizationPort } from "./port/DirectionAuthorizationPort.ts";
import type { ExecutionSummaryPort, ExecutionSummaryState } from "./port/ExecutionSummaryPort.ts";

export type OrchestrationResearchRequest = {
  id: string;
  kind: ResearchRequestKind;
  status: ResearchRequestStatus;
  originIntentId: string | null;
  originOutcomeId: string | null;
  updatedAt: number;
};

export type OrchestrationOutcome = {
  id: string;
  status: OutcomeStatus;
  updatedAt: number;
  /** Work（Story / Task）の現在の結果。相関付いたStoryが無ければnull。 */
  work: { state: ExecutionSummaryState; storyCount: number; taskCount: number } | null;
  /** Directionへ還流済みのExecution要約。未還流はnull。 */
  execution: { state: ExecutionState; executionCursor: number } | null;
  /** 最新のEvaluationと、それを根拠にしたDirection Decision（未判断はnull）。 */
  latestEvaluation: { id: string; executionCursor: number; decisionId: string | null; createdAt: number } | null;
};

/**
 * Orchestratorが専門Roleの起動を判断するための、1 Projectの現在状態。本文（Mission・Intentの内容・Research本文等）は含めず、
 * 状態とIDだけを返す。何をどう判断するかは起動されたRoleがRole Contextから取得する。
 */
export type OrchestrationState = {
  project: { id: string; name: string; status: ProjectStatus };
  activeIntent: { id: string; status: IntentStatus; updatedAt: number } | null;
  /** Active Intent配下の全状態のOutcome（新しい順）。Active Intentが無ければ空。 */
  outcomes: OrchestrationOutcome[];
  /** Active Intentを発端とする全状態のResearch Request（新しい順）。Active Intentが無ければ空。 */
  intentResearchRequests: OrchestrationResearchRequest[];
  /** Project内の未終了（requested / running）のResearch Request。発端Intentを問わない（新しい順）。 */
  openResearchRequests: OrchestrationResearchRequest[];
  observedAt: number;
};

const toResearchRequest = (request: {
  id: string;
  kind: ResearchRequestKind;
  status: ResearchRequestStatus;
  originIntentId: string | null;
  originOutcomeId: string | null;
  updatedAt: number;
}): OrchestrationResearchRequest => ({
  id: request.id,
  kind: request.kind,
  status: request.status,
  originIntentId: request.originIntentId,
  originOutcomeId: request.originOutcomeId,
  updatedAt: request.updatedAt,
});

/**
 * 外部Orchestrator向けの現在状態Query。Direction自身のrecordと、Workの結果（`ExecutionSummaryPort`）だけを読み、書込はしない。
 * Activity・Runtime eventのcursorには依存しない（同じ状態からは同じ応答になる）。
 */
export class GetOrchestrationStateUseCase<TCaller> {
  constructor(
    private readonly authorization: DirectionRuntimeAuthorizationPort<TCaller>,
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: ProjectIntentReader,
    private readonly outcomeRepository: ProjectOutcomeReader,
    private readonly researchRepository: Pick<ResearchRepository, "findRequests" | "findRequestDetail" | "findIntentResearchSummary" | "findRelatedFindings">,
    private readonly directionDecisionRepository: Pick<DirectionDecisionRepository, "findByIntent">,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
    private readonly executionSummary: ExecutionSummaryPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(caller: TCaller, projectId: string): Promise<OrchestrationState> {
    // 認可はProjectの存在確認より先。scopeの無い呼出しへProjectの存在有無を漏らさない。
    await this.authorization.requireScope(caller, projectId, "runtime:state:read");
    const project = await this.projectReader.findDetailById(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);

    const requests = await this.researchRepository.findRequests(projectId);
    const openResearchRequests = requests.filter((request) => !isClosedResearchStatus(request.status)).map(toResearchRequest);
    const intents = await this.intentRepository.findByProject(projectId);
    const activeIntent = intents.find((intent) => intent.status === "active") ?? null;
    const base = {
      project: { id: project.id, name: project.name, status: project.status },
      openResearchRequests,
      observedAt: this.clock(),
    };
    if (!activeIntent) return { ...base, activeIntent: null, outcomes: [], intentResearchRequests: [] };

    const decisions = await this.directionDecisionRepository.findByIntent(projectId, activeIntent.id);
    const decidedBy = new Map(
      decisions.filter((decision) => decision.evaluationId !== null).map((decision) => [decision.evaluationId, decision.id]),
    );
    const latestEvaluations = new Map(
      (await this.outcomeEvaluationRepository.findLatestByIntent(project.workspaceId, activeIntent.id)).map((evaluation) => [
        evaluation.outcomeId,
        evaluation,
      ]),
    );
    const outcomes: OrchestrationOutcome[] = [];
    for (const outcome of await this.outcomeRepository.findByIntent(projectId, activeIntent.id)) {
      const work = await this.executionSummary.getOutcomeExecutionSummary(projectId, outcome.id);
      const execution = await this.outcomeExecutionRepository.find(project.workspaceId, projectId, outcome.id);
      const evaluation = latestEvaluations.get(outcome.id);
      outcomes.push({
        id: outcome.id,
        status: outcome.status,
        updatedAt: outcome.updatedAt,
        work: work
          ? {
              state: work.state,
              storyCount: work.stories.length,
              taskCount: work.stories.reduce(
                (sum, story) => sum + Object.values(story.taskCounts).reduce((total, count) => total + count, 0),
                0,
              ),
            }
          : null,
        execution: execution
          ? { state: execution.summary.state, executionCursor: execution.summary.executionCursor }
          : null,
        latestEvaluation: evaluation
          ? {
              id: evaluation.id,
              executionCursor: evaluation.snapshot.execution.executionCursor,
              decisionId: decidedBy.get(evaluation.id) ?? null,
              createdAt: evaluation.createdAt,
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
        .map(toResearchRequest),
    };
  }
}
