import type { Intent } from "../domain/Intent.ts";
import type { Outcome } from "../domain/Outcome.ts";
import type { OutcomeEvaluation } from "../domain/OutcomeEvaluation.ts";
import type { OutcomeExecutionRecord } from "../domain/OutcomeExecution.ts";
import type { Workspace } from "@compass/organization";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
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
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
  ) {}

  async execute(principalId: string, workspaceId: string, outcomeId: string): Promise<EvaluatorContext> {
    // 公開入口で認可済みの主体・scopeを受け取る。
    const workspace = await this.workspaceReader.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    // 別WorkspaceのOutcome IDも同じNOT_FOUND。
    const outcome = await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    return {
      principalId,
      role: DirectionAgentRole.EVALUATOR,
      workspace,
      intent: await this.intentRepository.findById(workspaceId, outcome.intentId),
      outcome,
      execution: await this.soleExecution(workspaceId, outcomeId),
      evaluations: await this.outcomeEvaluationRepository.findByOutcome(workspaceId, outcomeId),
      unavailable: unavailableEvaluatorInputs,
    };
  }
  private async soleExecution(workspaceId: string, outcomeId: string): Promise<OutcomeExecutionRecord | null> {
    const records = await this.outcomeExecutionRepository.findByOutcome(workspaceId, outcomeId);
    if (records.length > 1) throw new ConflictError("Multiple Project evaluation requires the Target evaluation contract", { reason: "multi_project_evaluation_required" });
    return records[0] ?? null;
  }
}
