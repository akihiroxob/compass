import type { Intent } from "../domain/Intent.ts";
import type { Outcome } from "../domain/Outcome.ts";
import type { ProjectDetail, Workspace } from "@compass/organization";
import type { IntentResearchSummary } from "../domain/Research.ts";
import type { OutcomeEvaluation } from "../domain/OutcomeEvaluation.ts";
import type { DirectionDecisionRepository } from "../domain/DirectionDecisionRepository.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import type { OutcomeTargetProjectRepository, OutcomeTargetProjectView } from "../domain/OutcomeTargetProject.ts";
import { NotFoundError } from "@compass/shared";
import { DirectionAgentRole } from "./port/DirectionAuthorizationPort.ts";

/** 未実装で、Agentが存在を仮定・捏造してはならない入力。実装した時点で該当要素を外す。 */
export const strategistResearchLimit = 50;

export const unavailableStrategistInputs = ["evidence"] as const;

/**
 * Outcomeごとの最新のEvaluation。`decisionId`はこの評価を根拠にしたDirection Decision（未判断ならnull）で、
 * nullの評価が再計画・Intent完了の判断待ち。古い評価（同じOutcomeの再評価で置き換えられたもの）は含めない。
 */
export type StrategistEvaluation = OutcomeEvaluation & { decisionId: string | null };

/** WorkspaceのIntent配下の最新Evaluationを読むport。 */
export interface WorkspaceEvaluationReader {
  findLatestByIntent(workspaceId: string, intentId: string): Promise<OutcomeEvaluation[]>;
}

/**
 * Target判断の材料にするProjectの要約。purpose（`description`）とRepository・Resourceの参照（名前・URL・種類）だけを持ち、
 * Resourceの本文は含めない。本文は各参照の正本から取得する。
 */
export type StrategistProjectSummary = Pick<ProjectDetail, "id" | "name" | "description" | "repositories" | "resources">;

/** WorkspaceのactiveなProjectを読むport（Organizationが所有）。Organizationの`ProjectRepository`がこの形を満たす。 */
export interface WorkspaceProjectReader {
  findAllInWorkspace(workspaceId: string): Promise<(StrategistProjectSummary & Pick<ProjectDetail, "createdAt">)[]>;
}

export type StrategistContext = {
  principalId: string;
  role: DirectionAgentRole;
  workspace: Workspace;
  activeIntent: Intent | null;
  /** Active Intent配下の全状態のOutcome（新しい順）。取消済みも含め、過去の試行の重複提案を避けられるようにする。 */
  outcomes: Outcome[];
  /** WorkspaceのactiveなProjectの要約（作成順）。Target Projectの選択肢。 */
  projects: StrategistProjectSummary[];
  /** `outcomes`の各Outcomeの現在のTarget（`outcomes`の順、Outcome内は設定順）。archivedのProjectは`projectStatus`で示す。 */
  outcomeTargets: OutcomeTargetProjectView[];
  /** Active IntentのIntent Brief（関連Synthesis要約・競合・鮮度・残予算の根拠）。Active Intentが無ければnull。 */
  research: IntentResearchSummary | null;
  /** Active Intent配下の各Outcomeの最新Evaluation（新しい順）。Active Intentが無ければ空。 */
  evaluations: StrategistEvaluation[];
  researchHistory: { requestCount: number; synthesisCount: number; conflictCount: number; truncated: boolean } | null;
  unavailable: readonly string[];
};

/**
 * StrategistがOutcomeを決めるために必要な、Workspace・Active Intent・既存Outcome・Intent Brief・最新のOutcome Evaluation・
 * Project要約・現在のTargetを1回で返す。Evaluationは再計画（次のOutcome・追加Research）とIntent完了の判断材料で、
 * Evidence本文は含めない。Project要約とTargetは、StrategistがTargetの要否と対象を判断する材料（選択はStrategistが行う）。
 */
export class GetStrategistContextUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly researchRepository: Pick<ResearchRepository, "findRequests" | "findRequestDetail" | "findIntentResearchSummary" | "findRelatedFindings">,
    private readonly directionDecisionRepository: Pick<DirectionDecisionRepository, "findByIntent">,
    private readonly outcomeEvaluationRepository: WorkspaceEvaluationReader,
    private readonly projectReader: WorkspaceProjectReader,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByOutcome">,
  ) {}

  async execute(principalId: string, workspaceId: string): Promise<StrategistContext> {
    const workspace = await this.workspaceReader.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    const intents = await this.intentRepository.findByWorkspace(workspaceId);
    const activeIntent = intents.find((intent) => intent.status === "active") ?? null;
    const outcomes = activeIntent
      ? await this.outcomeRepository.findByIntent(workspaceId, activeIntent.id)
      : [];
    const research = activeIntent
      ? await this.researchRepository.findIntentResearchSummary(workspaceId, activeIntent.id)
      : null;
    const evaluations = activeIntent ? await this.evaluationsOf(workspaceId, activeIntent.id) : [];
    const projects = (await this.projectReader.findAllInWorkspace(workspaceId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, name, description, repositories, resources }) => ({ id, name, description, repositories, resources }));
    const outcomeTargets: OutcomeTargetProjectView[] = [];
    for (const outcome of outcomes) outcomeTargets.push(...((await this.targetRepository.listByOutcome(workspaceId, outcome.id)) ?? []));
    return {
      principalId,
      role: DirectionAgentRole.STRATEGIST,
      workspace,
      activeIntent,
      outcomes,
      projects,
      outcomeTargets,
      research: research ? { requests: research.requests.slice(0, strategistResearchLimit),
        syntheses: research.syntheses.slice(0, strategistResearchLimit), conflicts: research.conflicts.slice(0, strategistResearchLimit) } : null,
      researchHistory: research ? { requestCount: research.requests.length, synthesisCount: research.syntheses.length,
        conflictCount: research.conflicts.length, truncated: [research.requests, research.syntheses, research.conflicts].some(items => items.length > strategistResearchLimit) } : null,
      evaluations,
      unavailable: unavailableStrategistInputs,
    };
  }

  private async evaluationsOf(workspaceId: string, intentId: string): Promise<StrategistEvaluation[]> {
    const evaluations = await this.outcomeEvaluationRepository.findLatestByIntent(workspaceId, intentId);
    if (evaluations.length === 0) return [];
    const decisions = await this.directionDecisionRepository.findByIntent(workspaceId, intentId);
    const decidedBy = new Map(
      decisions.filter((decision) => decision.evaluationId !== null).map((decision) => [decision.evaluationId, decision.id]),
    );
    return evaluations.map((evaluation) => ({ ...evaluation, decisionId: decidedBy.get(evaluation.id) ?? null }));
  }
}
