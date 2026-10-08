import type { Intent } from "../domain/Intent.ts";
import type { Outcome } from "../domain/Outcome.ts";
import type { OutcomeEvaluation } from "../domain/OutcomeEvaluation.ts";
import { assessOutcomeEvaluability, type OutcomeEvaluability, type OutcomeTargetExecution } from "../domain/OutcomeEvaluability.ts";
import type { OutcomeTargetProjectRepository } from "../domain/OutcomeTargetProject.ts";
import type { Workspace } from "@compass/organization";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { NotFoundError } from "@compass/shared";
import { readOutcomeTargetExecutions } from "./OutcomeTargetProjectUseCases.ts";
import { DirectionAgentRole } from "./port/DirectionAuthorizationPort.ts";

/** Evaluatorが存在を仮定・捏造してはならない入力。Evidenceは参照だけで、本文は保存していない。 */
export const unavailableEvaluatorInputs = ["evidence_content"] as const;

export type EvaluatorContext = {
  principalId: string;
  role: DirectionAgentRole;
  workspace: Workspace;
  /** Outcomeの発端のIntent。 */
  intent: Intent | null;
  /** 固定のSuccess Criteria（`id`・`position`・`description`・`measurement`・`target`）を含む。Evaluatorは変更できない。 */
  outcome: Outcome;
  /**
   * 全Target（設定順、`projectStatus`付き）と、各Targetから還流済みのSummary・Evidence参照（未還流はnull）。
   * Project別のまま並べ、合算しない。Target解除前に還流された記録は評価の入力ではないため含めない。
   */
  targets: OutcomeTargetExecution[];
  /** 全Targetから見た評価可能性。`evaluable`以外ではEvaluationを保存できない。 */
  evaluability: OutcomeEvaluability;
  /** このOutcomeの過去の評価（新しい順）。再評価するときの比較に使う。 */
  evaluations: readonly OutcomeEvaluation[];
  unavailable: readonly string[];
};

/**
 * Evaluatorが評価するために必要な入力（固定Success Criteria・全TargetのExecution Summary・Evidence参照・評価可能性・過去の評価）を1回で返す。
 * 読取だけで、Outcome・Executionを変更しない。Evidence本文は含まないため、参照先の観測はEvaluator自身が行う。
 */
export class GetEvaluatorContextUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByOutcome">,
    private readonly outcomeExecutionRepository: Pick<OutcomeExecutionRepository, "findByOutcome">,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
  ) {}

  async execute(principalId: string, workspaceId: string, outcomeId: string): Promise<EvaluatorContext> {
    // 公開入口で認可済みの主体・scopeを受け取る。
    const workspace = await this.workspaceReader.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    // 別WorkspaceのOutcome IDも同じNOT_FOUND。
    const outcome = await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId);
    const read = await readOutcomeTargetExecutions(this.targetRepository, this.outcomeExecutionRepository, workspaceId, outcomeId);
    if (!outcome || !read) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    return {
      principalId,
      role: DirectionAgentRole.EVALUATOR,
      workspace,
      intent: await this.intentRepository.findById(workspaceId, outcome.intentId),
      outcome,
      targets: read.targets,
      evaluability: assessOutcomeEvaluability(read.targets),
      evaluations: await this.outcomeEvaluationRepository.findByOutcome(workspaceId, outcomeId),
      unavailable: unavailableEvaluatorInputs,
    };
  }
}
