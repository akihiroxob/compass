import { ProjectRole } from "../../constants/ProjectRole.ts";
import {
  deriveEvaluationResult,
  type CriterionEvaluation,
  type EvaluationSnapshot,
  type OutcomeEvaluation,
} from "../../domain/model/OutcomeEvaluation.ts";
import type {
  OutcomeEvaluationRepository,
  OutcomeEvaluationRequest,
} from "../../domain/repository/OutcomeEvaluationRepository.ts";
import type { OutcomeExecutionRepository } from "../../domain/repository/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseRecordOutcomeEvaluationInput } from "../../shared/outcomeEvaluationSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";
import { ValidationError } from "../error/ValidationError.ts";
import type { Principal, ProjectAuthorizationService } from "../service/ProjectAuthorizationService.ts";

export type RecordOutcomeEvaluationResult = {
  evaluation: OutcomeEvaluation;
  /** 新しく保存した。同じrequestKeyの再送では、保存済みの評価を返してfalse。 */
  recorded: boolean;
};

/**
 * Evaluatorが、Outcomeの固定Success Criteriaを1件ずつ観測結果で判定した内容を、追記のEvaluationとして保存する。
 * 総合結果（achieved / failed / insufficient_evidence）はCriterionの判定から導出し、Executionの`accepted`だけでは
 * `achieved`にならない。`met` / `not_met`は、このOutcomeに還流済みのEvidence参照を根拠に持たなければ保存できない。
 * Outcome・Success Criteria・Executionの結果は変更しない。保存と同じtransactionで`outcome_evaluated`イベントを作り、
 * RuntimeがStrategistを起動する条件にする。再計画・Intent完了の判断はStrategistのDirection Decisionが行う（Task 36）。
 */
export class RecordOutcomeEvaluationUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
    private readonly clock: () => number,
  ) {}

  async execute(
    principal: Principal,
    projectId: string,
    outcomeId: string,
    input: unknown,
  ): Promise<RecordOutcomeEvaluationResult> {
    // 認可はProjectの存在確認より先。Grantを持たないPrincipalへProjectやOutcomeの存在有無を漏らさない。
    const principalId = await this.authorization.requireRole(principal, projectId, ProjectRole.EVALUATOR);
    const parsed = parseRecordOutcomeEvaluationInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const outcome = await this.outcomeRepository.findByIdInProject(projectId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${projectId}`);

    const request: OutcomeEvaluationRequest = {
      outcomeId,
      requestKey: parsed.requestKey,
      runRef: parsed.runRef,
      criteria: parsed.criteria,
      principalId,
    };
    // 再送は状態の検査より先に確認する。評価後にOutcomeやExecutionが変わっても、応答を失った再送は同じ評価を返す。
    const replay = await this.outcomeEvaluationRepository.findReplay(projectId, request);
    if (replay.kind === "replayed") return { evaluation: replay.evaluation, recorded: false };
    if (replay.kind === "key_conflict") throw this.keyConflict(replay.requestKey);

    if (outcome.status !== "active") {
      throw new ConflictError(`Outcome ${outcomeId} is ${outcome.status}; only an active Outcome is evaluated`, {
        outcomeStatus: outcome.status,
      });
    }
    const execution = await this.outcomeExecutionRepository.find(projectId, outcomeId);
    if (execution === null) {
      throw new ConflictError(`Execution has not been reflected into Outcome ${outcomeId} yet`, {
        reason: "no_execution_summary",
      });
    }

    const criteria = this.judge(outcome.successCriteria, parsed.criteria, new Set(execution.evidence.map((item) => item.id)));
    const snapshot: EvaluationSnapshot = {
      outcome: {
        title: outcome.title,
        description: outcome.description,
        hypothesis: outcome.hypothesis,
        status: outcome.status,
      },
      execution: {
        correlationId: execution.summary.correlationId,
        state: execution.summary.state,
        stories: execution.summary.stories,
        executionCursor: execution.summary.executionCursor,
        observedCursor: execution.summary.observedCursor,
      },
      evidence: execution.evidence.map(({ id, kind, uri, versionHash, observedAt }) => ({
        id,
        kind,
        uri,
        versionHash,
        observedAt,
      })),
    };

    const saved = await this.outcomeEvaluationRepository.record(projectId, {
      request,
      intentId: outcome.intentId,
      result: deriveEvaluationResult(criteria.map((criterion) => criterion.verdict)),
      criteria,
      snapshot,
      at: this.clock(),
    });
    if (saved.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (saved.kind === "key_conflict") throw this.keyConflict(saved.requestKey);
    if (saved.kind === "intent_not_active") {
      throw new ConflictError(`Intent ${outcome.intentId} is ${saved.status}; only an Outcome of an active Intent is evaluated`, {
        reason: "intent_not_active",
        status: saved.status,
      });
    }
    return { evaluation: saved.evaluation, recorded: saved.kind === "created" };
  }

  /**
   * 固定のSuccess Criteriaすべてを1回ずつ判定していること、根拠のEvidence参照がこのOutcomeに還流済みであることを確認し、
   * Outcomeの定義（position順）に評価時のsnapshotを添えた判定を返す。
   */
  private judge(
    successCriteria: readonly { id: string; position: number; description: string; measurement: string; target: string | null }[],
    judgments: OutcomeEvaluationRequest["criteria"],
    evidenceIds: ReadonlySet<string>,
  ): CriterionEvaluation[] {
    const issues: { path: string; message: string }[] = [];
    const byId = new Map(successCriteria.map((criterion) => [criterion.id, criterion]));
    const judged = new Map<string, OutcomeEvaluationRequest["criteria"][number]>();
    judgments.forEach((judgment, index) => {
      if (!byId.has(judgment.criterionId)) {
        issues.push({
          path: `criteria.${index}.criterionId`,
          message: `criterionId ${judgment.criterionId} is not a Success Criterion of this Outcome`,
        });
        return;
      }
      judged.set(judgment.criterionId, judgment);
      judgment.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.has(evidenceId)) {
          issues.push({
            path: `criteria.${index}.evidenceIds.${evidenceIndex}`,
            message: `evidenceId ${evidenceId} is not an Evidence reference reflected into this Outcome`,
          });
        }
      });
    });
    const missing = successCriteria.filter((criterion) => !judged.has(criterion.id));
    if (missing.length > 0 && !issues.some((issue) => issue.path.endsWith(".criterionId"))) {
      issues.push({
        path: "criteria",
        message: `criteria must judge every Success Criterion; missing: ${missing.map((criterion) => criterion.id).join(", ")}`,
      });
    }
    if (issues.length > 0) throw new ValidationError("Outcome Evaluation input is invalid", issues);

    return [...successCriteria]
      .sort((left, right) => left.position - right.position)
      .map((criterion) => {
        const judgment = judged.get(criterion.id)!;
        return {
          criterionId: criterion.id,
          position: criterion.position,
          description: criterion.description,
          measurement: criterion.measurement,
          target: criterion.target,
          verdict: judgment.verdict as CriterionEvaluation["verdict"],
          rationale: judgment.rationale,
          evidenceIds: [...judgment.evidenceIds],
        };
      });
  }

  private keyConflict(requestKey: string) {
    return new ConflictError(`requestKey ${requestKey} was already used with different content`, { requestKey });
  }
}
