import type { RuntimeEvent } from "./RuntimeEvent.ts";

/**
 * consumer（Runtime）がイベントを処理した結果。
 * - `processed`: 起動条件を満たして処理を引き受けた。以後そのconsumerへ再配信しない。
 * - `retryable_failure`: 今回は処理できなかったが、再試行してよい。次の取得でも返り続ける（backoffはRuntimeの責務）。
 * - `terminal_failure`: 再試行しても成功しない。以後そのconsumerへ再配信しない。理由を残す。
 */
export const runtimeEventAckOutcomes = ["processed", "retryable_failure", "terminal_failure"] as const;
export type RuntimeEventAckOutcome = (typeof runtimeEventAckOutcomes)[number];

/** 再配信されない状態。この状態から別の結果へは変えない（変えられるのはretryable_failureだけ）。 */
export const isSettledAckOutcome = (outcome: RuntimeEventAckOutcome): boolean => outcome !== "retryable_failure";

export type RuntimeEventDelivery = {
  readonly consumerId: string;
  readonly eventId: string;
  readonly cursor: number;
  readonly outcome: RuntimeEventAckOutcome;
  /** `retryable_failure`を受けた回数。`processed` / `terminal_failure`は失敗として数えない。 */
  readonly retryCount: number;
  readonly lastFailureReason: string | null;
  readonly updatedAt: number;
};

/** consumerに未処理として返すイベント。再試行中のイベントには過去の失敗が付く。 */
export type PendingRuntimeEvent = RuntimeEvent & {
  readonly retryCount: number;
  readonly lastFailureReason: string | null;
};

export type RuntimeEventFetch = {
  readonly events: readonly PendingRuntimeEvent[];
  /**
   * 同じ取得周回で次ページへ進むための`afterCursor`。返したイベントの末尾のcursor。空なら渡された`afterCursor`のまま。
   * 未ackや`retryable_failure`のイベントを追い越すため、再起動後の再開位置として永続化しない。
   */
  readonly nextCursor: number;
  /**
   * 再起動後の再開に使う`afterCursor`。このconsumerにとって、これ以下のイベントがすべて確定済み
   * （`processed` / `terminal_failure`）である最大のcursor。未確定のイベントを追い越さないため、
   * ここから取得し直しても欠落しない。
   */
  readonly resumeCursor: number;
};

export type AckRuntimeEventResult = {
  readonly delivery: RuntimeEventDelivery;
  /**
   * 状態を変えなかった場合はfalse。同じ`attemptId`の再送（初回の結果を返す）と、
   * 確定済みの結果と同じ結果の別`attemptId`での再送が該当する。
   */
  readonly recorded: boolean;
};
