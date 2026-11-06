/**
 * Intent（ビジネス目標）に関連する観測項目と、その時系列の観測値。
 *
 * 観測項目（Metric）は単位・任意の目標値・鮮度の期限を明示的に持つ。目標値や比率をIntentの説明文から抽出・推測しない。
 * 観測値は対象期間（暦日）ごとの版（revision）を追記で持つ。同じ内容の再送は新しい版を作らず、内容が変われば次の版になる。
 * 取得失敗も観測の一つとして残し、値なし（null）で保存する。値が無い期間をゼロや補間値で埋めない。
 */

export const intentMetricObservationStatuses = ["observed", "failed"] as const;

/** `observed`は値を取得できた、`failed`は取得を試みたが失敗した（値なし）。 */
export type IntentMetricObservationStatus = (typeof intentMetricObservationStatuses)[number];

export type IntentMetricSource = {
  /** 出所の名前（例: 計測基盤・レポート名）。 */
  name: string;
  /** 出所の参照先（http(s)）。本文は保存しない。 */
  uri: string | null;
};

export type IntentMetricObservation = {
  id: string;
  metricId: string;
  /** 対象期間の開始・終了（`YYYY-MM-DD`の暦日、両端を含む）。日次は開始と終了が同じ日。 */
  periodStart: string;
  periodEnd: string;
  /** 同じ対象期間の版。1から始まり、内容が変わるたびに増える。 */
  revision: number;
  status: IntentMetricObservationStatus;
  /** `observed`の値。ゼロも有効な観測値。`failed`はnull。 */
  value: number | null;
  /** `failed`の理由。`observed`はnull。 */
  failureReason: string | null;
  source: IntentMetricSource;
  /** 値を観測（取得）した時刻（epoch milliseconds）。 */
  observedAt: number;
  /** 記録したPrincipal（Bearerから解決した値）。 */
  principalId: string;
  recordedAt: number;
};

export type IntentMetric = {
  id: string;
  workspaceId: string;
  intentId: string;
  /** Intent内で一意な識別子（例: `monthly_revenue`）。観測の記録はこのkeyで対象を指定する。 */
  key: string;
  name: string;
  /** 値の単位（例: `円`・`人`・`%`）。観測値はすべてこの単位で記録する。 */
  unit: string;
  /** 明示的に設定した目標値。未設定はnull（説明文から生成しない）。 */
  targetValue: number | null;
  /** 最新の観測の対象期間の終了日から、この日数を超えると古い観測（`stale`）とみなす。 */
  staleAfterDays: number;
  /** 定義の版。名前・目標値・鮮度の期限を変えるたびに増える。 */
  revision: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * 現在の観測状態。
 * - `unmeasured`: 観測が1件もない
 * - `failed`: 最新の対象期間の観測が取得失敗
 * - `stale`: 最新の観測値が`staleAfterDays`を超えて古い
 * - `observed`: 期限内の観測値がある（ゼロを含む）
 */
export type IntentMetricCurrentState = "unmeasured" | "failed" | "stale" | "observed";

export type IntentMetricCurrent = {
  state: IntentMetricCurrentState;
  /** 最新の対象期間の最新版（取得失敗を含む）。観測なしはnull。 */
  latest: IntentMetricObservation | null;
  /** 値を取得できた最新の観測。取得失敗だけ・観測なしはnull。 */
  lastObserved: IntentMetricObservation | null;
};

const dayMilliseconds = 86_400_000;

/** `YYYY-MM-DD`同士の暦日の差（`to - from`）。 */
export const calendarDaysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMilliseconds);

/** epoch millisecondsのUTC暦日。 */
export const utcCalendarDate = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** 暦日に日数を足した暦日。 */
export const addCalendarDays = (date: string, days: number): string =>
  utcCalendarDate(Date.parse(`${date}T00:00:00Z`) + days * dayMilliseconds);

/**
 * 最新の観測（取得失敗を含む）と値を取得できた最新の観測から、現在の状態を導出する。鮮度はUTCの暦日で判定する。
 * 値の無い状態をゼロや推測値へ置き換えない。
 */
export const deriveIntentMetricCurrent = (
  metric: Pick<IntentMetric, "staleAfterDays">,
  latest: IntentMetricObservation | null,
  lastObserved: IntentMetricObservation | null,
  now: number,
): IntentMetricCurrent => {
  if (latest === null) return { state: "unmeasured", latest: null, lastObserved: null };
  if (latest.status === "failed") return { state: "failed", latest, lastObserved };
  const age = calendarDaysBetween(latest.periodEnd, utcCalendarDate(now));
  return { state: age > metric.staleAfterDays ? "stale" : "observed", latest, lastObserved };
};
