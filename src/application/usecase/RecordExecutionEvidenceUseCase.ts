import type { OutcomeExecutionEvidence, OutcomeExecutionSummary } from "../../domain/model/OutcomeExecution.ts";
import type { OutcomeExecutionRepository } from "../../domain/repository/OutcomeExecutionRepository.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseRecordExecutionEvidenceInput } from "../../shared/executionEvidenceSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";
import { ValidationError } from "../error/ValidationError.ts";
import type { ExecutionSummaryPort } from "../port/ExecutionSummaryPort.ts";
import type { Caller, RuntimeAuthorizationService } from "../service/RuntimeAuthorizationService.ts";

/** 観測時刻として許す、現在時刻からの未来方向のずれ（時計の誤差分）。これを超える未来の観測は捏造として拒否する。 */
const observedAtSkewMilliseconds = 5 * 60 * 1000;

export type RecordExecutionEvidenceResult = {
  summary: OutcomeExecutionSummary;
  evidence: readonly OutcomeExecutionEvidence[];
  recorded: {
    /** 要約を新規作成または更新した。同じ通知の再送・古い通知ではfalse。 */
    summaryChanged: boolean;
    /** 報告されたcursorが保存済みの報告より古かった。要約は巻き戻さず、現在のExecution状態で回復している。 */
    staleInput: boolean;
    evidenceAdded: number;
  };
};

/**
 * 外部RuntimeがExecutionのChange（`list_changes`）を増分取得したあと、そのOutcomeの結果とEvidence参照を
 * Directionへ還流する。結果（accepted / rejected / canceled / incomplete）はRuntimeの申告ではなく、
 * `ExecutionSummaryPort`でExecutionの現在の状態から導出する。Runtimeが渡すのはEvidenceの参照
 * （URI・commit SHA・観測時刻）と、読んだところまでのChange cursorだけで、Evidence本文は受け取らない。
 * 導出は毎回現在の状態から行うため、通知の重複・順序逆転・再起動後の再送でも同じ最終状態に収束する。
 * Success Criterionの充足は判定しない（Evaluationの責務）。Outcomeを更新せず、Executionにも書き込まない。
 */
export class RecordExecutionEvidenceUseCase {
  constructor(
    private readonly authorization: RuntimeAuthorizationService,
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
    private readonly executionSummary: ExecutionSummaryPort,
    private readonly outcomeExecutionRepository: OutcomeExecutionRepository,
    private readonly clock: () => number,
  ) {}

  async execute(
    caller: Caller,
    projectId: string,
    outcomeId: string,
    input: unknown,
  ): Promise<RecordExecutionEvidenceResult> {
    // 認可はProjectの存在確認より先。Grantを持たないPrincipalへProjectやOutcomeの存在有無を漏らさない。
    const principalId = await this.authorization.requireScope(caller, projectId, "execution:evidence:write");
    const parsed = parseRecordExecutionEvidenceInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    // 別ProjectのOutcome IDも同じNOT_FOUND（存在を区別して漏らさない）。
    const outcome = await this.outcomeRepository.findByIdInProject(projectId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${projectId}`);
    if (outcome.status === "cancelled") {
      throw new ConflictError(`Outcome ${outcomeId} is cancelled; Execution evidence is not recorded`, {
        outcomeStatus: "cancelled",
      });
    }

    const now = this.clock();
    const future = parsed.evidence.findIndex((item) => item.observedAt > now + observedAtSkewMilliseconds);
    if (future >= 0) {
      throw new ValidationError("Execution evidence input is invalid", [
        { path: `evidence.${future}.observedAt`, message: "observedAt must not be in the future" },
      ]);
    }

    const snapshot = await this.executionSummary.getOutcomeExecutionSummary(projectId, outcomeId);
    if (snapshot === null) {
      // Storyが無い（未着手）。存在しないOutcomeとは区別し、Managerが`issue_story`した後に再試行できる。
      throw new ConflictError(`No Execution Story is correlated with Outcome ${outcomeId} yet`, {
        reason: "no_correlated_story",
      });
    }
    if (parsed.changeCursor > snapshot.headChangeCursor) {
      throw new ValidationError("Execution evidence input is invalid", [
        {
          path: "changeCursor",
          message: `changeCursor ${parsed.changeCursor} is ahead of the Execution change log (${snapshot.headChangeCursor})`,
        },
      ]);
    }

    const result = await this.outcomeExecutionRepository.record(projectId, {
      outcomeId,
      correlationId: snapshot.correlationId,
      state: snapshot.state,
      stories: snapshot.stories,
      executionCursor: snapshot.latestChangeCursor,
      changeCursor: parsed.changeCursor,
      evidence: parsed.evidence,
      principalId,
      at: now,
    });
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "evidence_limit_exceeded") {
      throw new ConflictError(`Outcome ${outcomeId} already has too many Evidence references (limit ${result.limit})`, {
        reason: "evidence_limit_exceeded",
      });
    }
    return {
      summary: result.record.summary,
      evidence: result.record.evidence,
      recorded: {
        summaryChanged: result.summaryChanged,
        staleInput: result.staleInput,
        evidenceAdded: result.evidenceAdded,
      },
    };
  }
}
