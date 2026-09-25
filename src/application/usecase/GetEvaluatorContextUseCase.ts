import { ProjectRole } from "../../constants/ProjectRole.ts";
import type { Intent } from "../../domain/model/Intent.ts";
import type { Outcome } from "../../domain/model/Outcome.ts";
import type { OutcomeEvaluation } from "../../domain/model/OutcomeEvaluation.ts";
import type { OutcomeExecutionRecord } from "../../domain/model/OutcomeExecution.ts";
import type { Project } from "../../domain/model/Project.ts";
import type { IntentRepository } from "../../domain/repository/IntentRepository.ts";
import type { OutcomeEvaluationRepository } from "../../domain/repository/OutcomeEvaluationRepository.ts";
import type { OutcomeExecutionRepository } from "../../domain/repository/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import type { Principal, ProjectAuthorizationService } from "../service/ProjectAuthorizationService.ts";

/** Evaluatorが存在を仮定・捏造してはならない入力。Evidenceは参照だけで、本文は保存していない。 */
export const unavailableEvaluatorInputs = ["evidence_content"] as const;

export type EvaluatorContext = {
  principalId: string;
  role: ProjectRole;
  project: Project;
  /** Outcomeの発端のIntent。 */
  intent: Intent | null;
  /** 固定のSuccess Criteria（`id`・`position`・`description`・`measurement`・`target`）を含む。Evaluatorは変更できない。 */
  outcome: Outcome;
  /** Executionから還流済みの結果とEvidence参照。まだ還流されていなければnull（この間は評価を確定できない）。 */
  execution: OutcomeExecutionRecord | null;
  /** このOutcomeの過去の評価（新しい順）。再評価するときの比較に使う。 */
  evaluations: readonly OutcomeEvaluation[];
  unavailable: readonly string[];
};

/**
 * Evaluatorが評価するために必要な入力（固定Success Criteria・Execution Summary・Evidence参照・過去の評価）を1回で返す。
 * 読取だけで、Outcome・Executionを変更しない。Evidence本文は含まないため、参照先の観測はEvaluator自身が行う。
 */
export class GetEvaluatorContextUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly projectRepository: ProjectRepository,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
  ) {}

  async execute(principal: Principal, projectId: string, outcomeId: string): Promise<EvaluatorContext> {
    // 認可はProjectの存在確認より先。Grantを持たないPrincipalへProjectやOutcomeの存在有無を漏らさない。
    const principalId = await this.authorization.requireRole(principal, projectId, ProjectRole.EVALUATOR);
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    // 別ProjectのOutcome IDも同じNOT_FOUND。
    const outcome = await this.outcomeRepository.findByIdInProject(projectId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${projectId}`);
    return {
      principalId,
      role: ProjectRole.EVALUATOR,
      project,
      intent: await this.intentRepository.findById(projectId, outcome.intentId),
      outcome,
      execution: await this.outcomeExecutionRepository.find(projectId, outcomeId),
      evaluations: await this.outcomeEvaluationRepository.findByOutcome(projectId, outcomeId),
      unavailable: unavailableEvaluatorInputs,
    };
  }
}
