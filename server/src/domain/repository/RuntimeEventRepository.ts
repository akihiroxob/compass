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
  | { kind: "conflict"; current: RuntimeEventAckOutcome }
  /** 同じconsumerが同じイベントの同じ`attemptId`を別の入力（結果・理由）で使った。 */
  | { kind: "idempotency_conflict" };

export interface RuntimeEventRepository {
  /** 指定したProjectのイベントを、cursorが`afterCursor`より大きいものだけ昇順で最大`limit`件返す。別Projectのイベントは返さない。 */
  findAfter(projectId: string, afterCursor: number, limit: number): Promise<RuntimeEvent[]>;

  /**
   * consumerにとって未処理のイベントを返す。ack記録の無いものと`retryable_failure`のものが対象で、
   * `processed` / `terminal_failure`は返さない。読取専用で、取得しただけでは状態を変えない
   * （応答が失われても、次の取得で同じイベントを返せる）。
   */
  findPending(projectId: string, consumerId: string, afterCursor: number, limit: number): Promise<PendingRuntimeEvent[]>;

  /**
   * consumerにとって、これ以下のイベントがすべて確定済みである最大のcursor（再起動後の安全な再開位置）。
   * 未確定のイベントが無ければProjectの最新のcursor、イベントが無ければ0。
   */
  findResumeCursor(projectId: string, consumerId: string): Promise<number>;

  /**
   * イベントがProjectに属し、確定済みでなければ結果を保存する。同じ`attemptId`の再送は初回の結果を返して状態を変えず、
   * 確定済みの結果と同じ結果の別`attemptId`での再送も状態を変えない。
   */
  recordAck(input: {
    projectId: string;
    consumerId: string;
    attemptId: string;
    eventId: string;
    outcome: RuntimeEventAckOutcome;
    reason: string | null;
    at: number;
  }): Promise<AckRuntimeEventRecord>;
}
