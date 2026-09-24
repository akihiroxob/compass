import type {
  AckRuntimeEventResult,
  PendingRuntimeEvent,
  RuntimeEventAckOutcome,
} from "../model/RuntimeEventDelivery.ts";
import type { RuntimeEvent } from "../model/RuntimeEvent.ts";

export type AckRuntimeEventRecord =
  | ({ kind: "recorded" } & AckRuntimeEventResult)
  | { kind: "event_not_found" }
  /** 確定済み（processed / terminal_failure）の結果と異なる結果は上書きしない。 */
  | { kind: "conflict"; current: RuntimeEventAckOutcome };

export interface RuntimeEventRepository {
  /** 指定したProjectのイベントを、cursorが`afterCursor`より大きいものだけ昇順で最大`limit`件返す。別Projectのイベントは返さない。 */
  findAfter(projectId: string, afterCursor: number, limit: number): Promise<RuntimeEvent[]>;

  /**
   * consumerにとって未処理のイベントを返す。ack記録の無いものと`retryable_failure`のものが対象で、
   * `processed` / `terminal_failure`は返さない。読取専用で、取得しただけでは状態を変えない
   * （応答が失われても、次の取得で同じイベントを返せる）。
   */
  findPending(projectId: string, consumerId: string, afterCursor: number, limit: number): Promise<PendingRuntimeEvent[]>;

  /** イベントがProjectに属し、確定済みでなければ結果を保存する。同じ結果の再送は状態を変えない。 */
  recordAck(input: {
    projectId: string;
    consumerId: string;
    eventId: string;
    outcome: RuntimeEventAckOutcome;
    reason: string | null;
    at: number;
  }): Promise<AckRuntimeEventRecord>;
}
