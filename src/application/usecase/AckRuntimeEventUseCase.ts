import { ProjectRole } from "../../constants/ProjectRole.ts";
import type { AckRuntimeEventResult } from "../../domain/model/RuntimeEventDelivery.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { RuntimeEventRepository } from "../../domain/repository/RuntimeEventRepository.ts";
import { parseRuntimeEventAckInput } from "../../shared/runtimeEventSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import type { Principal, ProjectAuthorizationService } from "../service/ProjectAuthorizationService.ts";

/**
 * consumerがイベントの処理結果を記録する。`processed` / `terminal_failure`は以後そのconsumerへ再配信せず、
 * `retryable_failure`は次の取得でも返り続ける。consumerが処理試行ごとに付けた`attemptId`で応答消失後の再送を
 * 1回の試行へ収束させ、同じイベントで同じ`attemptId`を別の入力に使うとCONFLICT。確定済みの結果と同じ結果の再送は状態を変えず、異なる結果はCONFLICT。
 * archivedのProjectでも記録できる（Runtimeの取りこぼしを残さないため。Direction・Executionの状態は変えない）。
 */
export class AckRuntimeEventUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly projectRepository: ProjectRepository,
    private readonly runtimeEventRepository: RuntimeEventRepository,
    private readonly clock: () => number,
  ) {}

  async execute(principal: Principal, projectId: string, input: unknown): Promise<AckRuntimeEventResult> {
    const consumerId = await this.authorization.requireRole(principal, projectId, ProjectRole.RUNTIME);
    const { eventId, attemptId, outcome, reason } = parseRuntimeEventAckInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const record = await this.runtimeEventRepository.recordAck({
      projectId,
      consumerId,
      attemptId,
      eventId,
      outcome,
      reason: reason ?? null,
      at: this.clock(),
    });
    if (record.kind === "event_not_found") {
      throw new NotFoundError(`Runtime event ${eventId} was not found in Project ${projectId}`);
    }
    if (record.kind === "idempotency_conflict") {
      throw new ConflictError(`attemptId ${attemptId} was already used for event ${eventId} with a different result`, {
        eventId,
        attemptId,
      });
    }
    if (record.kind === "conflict") {
      throw new ConflictError(`Runtime event ${eventId} was already acknowledged as ${record.current}`, {
        eventId,
        currentOutcome: record.current,
      });
    }
    return { delivery: record.delivery, recorded: record.recorded };
  }
}
