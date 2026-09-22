import { ProjectRole } from "../../constants/ProjectRole.ts";
import type { Intent } from "../../domain/model/Intent.ts";
import type { Outcome } from "../../domain/model/Outcome.ts";
import type { Project } from "../../domain/model/Project.ts";
import type { IntentResearchSummary } from "../../domain/model/Research.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { ResearchRepository } from "../../domain/repository/ResearchRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import type { Principal, ProjectAuthorizationService } from "../service/ProjectAuthorizationService.ts";

/** 未実装で、Agentが存在を仮定・捏造してはならない入力。実装した時点で該当要素を外す。 */
export const unavailableStrategistInputs = ["evaluation", "evidence"] as const;

export type StrategistContext = {
  principalId: string;
  role: ProjectRole;
  project: Project;
  activeIntent: Intent | null;
  /** Active Intent配下の全状態のOutcome（新しい順）。取消済みも含め、過去の試行の重複提案を避けられるようにする。 */
  outcomes: Outcome[];
  /** Active IntentのIntent Brief（関連Synthesis要約・競合・鮮度・残予算の根拠）。Active Intentが無ければnull。 */
  research: IntentResearchSummary | null;
  unavailable: readonly string[];
};

/** StrategistがOutcomeを決めるために必要な、Project・Active Intent・既存Outcome・Intent Briefを1回で返す。 */
export class GetStrategistContextUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(principal: Principal, projectId: string): Promise<StrategistContext> {
    const principalId = await this.authorization.requireRole(principal, projectId, ProjectRole.STRATEGIST);
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    const intents = await this.intentRepository.findByProject(projectId);
    const activeIntent = intents.find((intent) => intent.status === "active") ?? null;
    const outcomes = activeIntent
      ? await this.outcomeRepository.findByIntent(projectId, activeIntent.id)
      : [];
    const research = activeIntent
      ? await this.researchRepository.findIntentResearchSummary(projectId, activeIntent.id)
      : null;
    return {
      principalId,
      role: ProjectRole.STRATEGIST,
      project,
      activeIntent,
      outcomes,
      research,
      unavailable: unavailableStrategistInputs,
    };
  }
}
