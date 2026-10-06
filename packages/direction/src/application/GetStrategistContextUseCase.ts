import type { Intent } from "../domain/Intent.ts";
import type { Outcome } from "../domain/Outcome.ts";
import type { ProjectDetail } from "@compass/organization";
import type { IntentResearchSummary } from "../domain/Research.ts";
import type { OutcomeEvaluation } from "../domain/OutcomeEvaluation.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { ProjectIntentReader } from "./port/ProjectDirectionReaders.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { ProjectOutcomeReader } from "./port/ProjectDirectionReaders.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { NotFoundError } from "@compass/shared";
import { DirectionAgentRole, type DirectionRoleAuthorizationPort, type Principal } from "./port/DirectionAuthorizationPort.ts";

/** 未実装で、Agentが存在を仮定・捏造してはならない入力。実装した時点で該当要素を外す。 */
export const unavailableStrategistInputs = ["evidence"] as const;

/**
 * Outcomeごとの最新のEvaluation。`decisionId`はこの評価を根拠にしたDirection Decision（未判断ならnull）で、
 * nullの評価が再計画・Intent完了の判断待ち。古い評価（同じOutcomeの再評価で置き換えられたもの）は含めない。
 */
export type StrategistEvaluation = OutcomeEvaluation & { decisionId: string | null };

export type StrategistContext = {
  principalId: string;
  role: DirectionAgentRole;
  project: ProjectDetail;
  activeIntent: Intent | null;
  /** Active Intent配下の全状態のOutcome（新しい順）。取消済みも含め、過去の試行の重複提案を避けられるようにする。 */
  outcomes: Outcome[];
  /** Active IntentのIntent Brief（関連Synthesis要約・競合・鮮度・残予算の根拠）。Active Intentが無ければnull。 */
  research: IntentResearchSummary | null;
  /** Active Intent配下の各Outcomeの最新Evaluation（新しい順）。Active Intentが無ければ空。 */
  evaluations: StrategistEvaluation[];
  unavailable: readonly string[];
};

/**
 * StrategistがOutcomeを決めるために必要な、Project・Active Intent・既存Outcome・Intent Brief・最新のOutcome Evaluationを
 * 1回で返す。Evaluationは再計画（次のOutcome・追加Research）とIntent完了の判断材料で、Evidence本文は含めない。
 */
export class GetStrategistContextUseCase {
  constructor(
    private readonly authorization: DirectionRoleAuthorizationPort,
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: ProjectIntentReader,
    private readonly outcomeRepository: ProjectOutcomeReader,
    private readonly researchRepository: ResearchRepository,
    private readonly directionDecisionRepository: DirectionDecisionRepository,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
  ) {}

  async execute(principal: Principal, projectId: string): Promise<StrategistContext> {
    const principalId = await this.authorization.requireRole(principal, projectId, DirectionAgentRole.STRATEGIST);
    const project = await this.projectReader.findDetailById(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    const intents = await this.intentRepository.findByProject(projectId);
    const activeIntent = intents.find((intent) => intent.status === "active") ?? null;
    const outcomes = activeIntent
      ? await this.outcomeRepository.findByIntent(projectId, activeIntent.id)
      : [];
    const research = activeIntent
      ? await this.researchRepository.findIntentResearchSummary(projectId, activeIntent.id)
      : null;
    const evaluations = activeIntent ? await this.evaluationsOf(projectId, activeIntent.id) : [];
    return {
      principalId,
      role: DirectionAgentRole.STRATEGIST,
      project,
      activeIntent,
      outcomes,
      research,
      evaluations,
      unavailable: unavailableStrategistInputs,
    };
  }

  private async evaluationsOf(projectId: string, intentId: string): Promise<StrategistEvaluation[]> {
    const evaluations = await this.outcomeEvaluationRepository.findLatestByIntent(projectId, intentId);
    if (evaluations.length === 0) return [];
    const decisions = await this.directionDecisionRepository.findByIntent(projectId, intentId);
    const decidedBy = new Map(
      decisions.filter((decision) => decision.evaluationId !== null).map((decision) => [decision.evaluationId, decision.id]),
    );
    return evaluations.map((evaluation) => ({ ...evaluation, decisionId: decidedBy.get(evaluation.id) ?? null }));
  }
}
