import {
  deriveEvaluationResult,
  snapshotEvaluationTargets,
  type CriterionEvaluation,
  type EvaluationSnapshot,
  type OutcomeEvaluation,
} from "../domain/OutcomeEvaluation.ts";
import type {
  OutcomeEvaluationRepository,
  OutcomeEvaluationRequest,
} from "../domain/OutcomeEvaluationRepository.ts";
import type { OutcomeExecutionRepository } from "../domain/OutcomeExecutionRepository.ts";
import { assessOutcomeEvaluability } from "../domain/OutcomeEvaluability.ts";
import type { OutcomeTargetProjectRepository } from "../domain/OutcomeTargetProject.ts";
import { readOutcomeTargetExecutions } from "./OutcomeTargetProjectUseCases.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseRecordOutcomeEvaluationInput } from "./outcomeEvaluationSchema.ts";
import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

/** 評価中にTarget・Summary / Evidenceが変わり続けた場合に、読み直して判定し直す上限。 */
const maximumAttempts = 3;

export type RecordOutcomeEvaluationResult = {
  evaluation: OutcomeEvaluation;
  /** 新しく保存した。同じrequestKeyの再送では、保存済みの評価を返してfalse。 */
  recorded: boolean;
};

/**
 * Evaluatorが、Outcomeの固定Success Criteriaを1件ずつ観測結果で判定した内容を、追記のEvaluationとして保存する。
 * 総合結果（achieved / failed / insufficient_evidence）はCriterionの判定から導出し、Executionの`accepted`だけでは
 * `achieved`にならない。全Targetから還流し`incomplete`が無い（評価可能な）Outcomeだけを評価し、snapshotへ全TargetのSummary・
 * EvidenceをProject別に写す。`met` / `not_met`は、いずれかのTargetが還流したEvidence参照を根拠に持たなければ保存できない。
 * 評価可能性の検査・snapshotは保存と同じtransactionで現在の全Targetと照合し、評価中のTarget追加・解除や還流で
 * 食い違えば保存せずに読み直す。Outcome・Success Criteria・Executionの結果は変更しない。保存と同じtransactionで`outcome_evaluated`イベントを作り、
 * RuntimeがStrategistを起動する条件にする。再計画・Intent完了の判断はStrategistのDirection Decisionが行う（Task 36）。
 */
export class RecordOutcomeEvaluationUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByOutcome">,
    private readonly outcomeExecutionRepository: Pick<OutcomeExecutionRepository, "findByOutcome">,
    private readonly outcomeEvaluationRepository: OutcomeEvaluationRepository,
    private readonly clock: () => number,
  ) {}

  async execute(
    workspaceId: string,
    principalId: string,
    outcomeId: string,
    input: unknown,
  ): Promise<RecordOutcomeEvaluationResult> {
    // 公開入口で認可済みの主体・scopeを受け取る。
    const parsed = parseRecordOutcomeEvaluationInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const request: OutcomeEvaluationRequest = {
      outcomeId,
      requestKey: parsed.requestKey,
      runRef: parsed.runRef,
      criteria: parsed.criteria,
      principalId,
    };
    // 保存までにTarget・Summary / Evidenceが変わったら、読み直して評価可能性から判定し直す。
    for (let attempt = 1; ; attempt += 1) {
      const saved = await this.attempt(workspaceId, outcomeId, request);
      if (saved) return saved;
      if (attempt === maximumAttempts) {
        throw new ConflictError(`Target Projects of Outcome ${outcomeId} kept changing while it was evaluated; retry the evaluation`, {
          reason: "targets_changed",
        });
      }
    }
  }

  /** 現在の状態を読んで評価・保存する。読取後に全Targetの状態が変わり保存しなかった場合はnull。 */
  private async attempt(
    workspaceId: string,
    outcomeId: string,
    request: OutcomeEvaluationRequest,
  ): Promise<RecordOutcomeEvaluationResult | null> {
    const outcome = await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    // 再送は状態の検査より先に確認する。評価後にOutcomeやExecutionが変わっても、応答を失った再送は同じ評価を返す。
    const replay = await this.outcomeEvaluationRepository.findReplay(workspaceId, request);
    if (replay.kind === "replayed") return { evaluation: replay.evaluation, recorded: false };
    if (replay.kind === "key_conflict") throw this.keyConflict(replay.requestKey);

    if (outcome.status !== "active") throw this.outcomeNotActive(outcomeId, outcome.status);
    const read = await readOutcomeTargetExecutions(this.targetRepository, this.outcomeExecutionRepository, workspaceId, outcomeId);
    if (!read) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    // 一部のTargetの完了だけでは評価しない。Targetなし・archived Targetの未完了はStrategist、activeなTargetの未完了は還流待ち。
    const evaluability = assessOutcomeEvaluability(read.targets);
    if (evaluability.status !== "evaluable") {
      const unfinished = evaluability.unfinishedTargets.map((target) => `${target.projectId} (${target.projectStatus}, ${target.reason})`);
      throw new ConflictError(
        `Outcome ${outcomeId} is not evaluable: ${evaluability.status}${unfinished.length ? `; unfinished Targets: ${unfinished.join(", ")}` : ""}`,
        { reason: evaluability.status, unfinishedProjectIds: evaluability.unfinishedTargets.map((target) => target.projectId).join(",") },
      );
    }

    const targets = snapshotEvaluationTargets(read.targets);
    const evidenceIds = new Set(targets.flatMap((target) => target.evidence.map((item) => item.id)));
    const criteria = this.judge(outcome.successCriteria, request.criteria, evidenceIds);
    const snapshot: EvaluationSnapshot = {
      outcome: {
        title: outcome.title,
        description: outcome.description,
        hypothesis: outcome.hypothesis,
        status: outcome.status,
      },
      targets,
    };

    const saved = await this.outcomeEvaluationRepository.record(workspaceId, {
      request,
      intentId: outcome.intentId,
      result: deriveEvaluationResult(criteria.map((criterion) => criterion.verdict)),
      criteria,
      snapshot,
      at: this.clock(),
    });
    if (saved.kind === "targets_changed") return null;
    if (saved.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (saved.kind === "key_conflict") throw this.keyConflict(saved.requestKey);
    if (saved.kind === "outcome_not_active") throw this.outcomeNotActive(outcomeId, saved.status);
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
            message: `evidenceId ${evidenceId} is not an Evidence reference reflected into this Outcome by its Target Projects`,
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

  private outcomeNotActive(outcomeId: string, status: string) {
    return new ConflictError(`Outcome ${outcomeId} is ${status}; only an active Outcome is evaluated`, { outcomeStatus: status });
  }

  private keyConflict(requestKey: string) {
    return new ConflictError(`requestKey ${requestKey} was already used with different content`, { requestKey });
  }
}
