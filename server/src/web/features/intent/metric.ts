// 目標（Intent）の観測項目と日次の推移。API応答の型と、表示用の純関数。
// 値の無い日をゼロや補間値で埋めず、未計測・取得失敗・古い観測・日次でない観測を区別する。比率・達成度は計算しない。
// テストからも読み込むため、純関数のmodule以外をimportしない。
import type { StatusTone } from "../../statusTone.ts";

export type MetricState = "unmeasured" | "failed" | "stale" | "observed";

export type MetricObservation = {
  id: string;
  metricId: string;
  periodStart: string;
  periodEnd: string;
  revision: number;
  status: "observed" | "failed";
  value: number | null;
  failureReason: string | null;
  source: { name: string; uri: string | null };
  observedAt: number;
};

export type IntentMetric = {
  id: string;
  key: string;
  name: string;
  unit: string;
  targetValue: number | null;
  staleAfterDays: number;
  current: { state: MetricState; latest: MetricObservation | null; lastObserved: MetricObservation | null };
  series: { from: string; to: string; points: MetricObservation[] };
};

/** `GET /api/workspaces/:workspaceId/intents/:intentId/metrics`の応答。 */
export type IntentMetrics = { intentId: string; observedAt: number; metrics: IntentMetric[] };

/** 推移の表示範囲（日数）。サーバーは366日まで受け付ける。 */
export const trendRanges = [7, 30] as const;
export type TrendRange = (typeof trendRanges)[number];

export const trendRangeLabels: Record<TrendRange, string> = { 7: "7日", 30: "30日" };

const dayMilliseconds = 86_400_000;

/** epoch millisecondsのUTC暦日（サーバーの鮮度判定と同じ暦）。 */
export const utcDate = (at: number): string => new Date(at).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => utcDate(Date.parse(`${date}T00:00:00Z`) + days * dayMilliseconds);

/** 末日までの`days`日分の範囲（両端を含む）。 */
export const trendWindow = (to: string, days: TrendRange): { from: string; to: string } => ({ from: addDays(to, -(days - 1)), to });

export const metricStateLabels: Record<MetricState, { label: string; tone: StatusTone }> = {
  unmeasured: { label: "未計測", tone: "muted" },
  failed: { label: "取得失敗", tone: "warning" },
  stale: { label: "観測が古い", tone: "warning" },
  observed: { label: "観測あり", tone: "progress" },
};

/** 値と単位。単位が記号（円・%）か語（人）かで空白を決めず、保存された単位をそのまま続ける。 */
export const formatMetricValue = (value: number, unit: string): string => `${value.toLocaleString("ja-JP")}${unit}`;

/** `YYYY-MM-DD`を`M/D`にする。 */
export const shortDate = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export type DailyPoint = { date: string; value: number | null; status: "observed" | "failed"; failureReason: string | null; revision: number };

/**
 * 範囲内の日次の観測（対象期間が1日）。同じ日の複数の版はserverが最新版だけを返す。
 * 複数日にまたがる観測は日次の推移に含めず、件数だけを`excluded`で返す（日ごとの値へ按分しない）。
 */
export const dailyPoints = (metric: IntentMetric, window: { from: string; to: string }): { points: DailyPoint[]; excluded: number } => {
  const inWindow = metric.series.points.filter((point) => point.periodEnd >= window.from && point.periodStart <= window.to);
  const daily = inWindow.filter((point) => point.periodStart === point.periodEnd && point.periodEnd >= window.from && point.periodEnd <= window.to);
  const byDate = new Map<string, DailyPoint>();
  for (const point of daily) {
    const existing = byDate.get(point.periodEnd);
    if (existing && existing.revision > point.revision) continue;
    byDate.set(point.periodEnd, { date: point.periodEnd, value: point.status === "observed" ? point.value : null, status: point.status, failureReason: point.failureReason, revision: point.revision });
  }
  return { points: [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : 1)), excluded: inWindow.length - daily.length };
};

/**
 * 最新の観測値と、その`days`日前の日次の観測値との差。どちらかが無い・取得失敗・日次でないときはnull（0とは扱わない）。
 */
export const changeFromEarlier = (metric: IntentMetric, days: number): { from: string; delta: number; earlier: number; latest: number } | null => {
  const latest = metric.current.lastObserved;
  if (!latest || latest.status !== "observed" || latest.value === null || latest.periodStart !== latest.periodEnd) return null;
  const earlierDate = addDays(latest.periodEnd, -days);
  const earlier = metric.series.points.find((point) => point.periodStart === earlierDate && point.periodEnd === earlierDate && point.status === "observed" && point.value !== null);
  if (!earlier || earlier.value === null) return null;
  return { from: earlierDate, delta: latest.value - earlier.value, earlier: earlier.value, latest: latest.value };
};

/** 差の表示。符号を付け、変化なしは「±0」。 */
export const formatDelta = (delta: number, unit: string): string => `${delta > 0 ? "+" : delta < 0 ? "-" : "±"}${Math.abs(delta).toLocaleString("ja-JP")}${unit}`;

export type MetricHeadline =
  | { kind: "value"; value: number; period: string; stale: boolean }
  | { kind: "none"; reason: "unmeasured" }
  | { kind: "failed"; reason: string | null; period: string; lastValue: { value: number; period: string } | null }
  | { kind: "stale_without_value" };

/**
 * 現在値の見出し。観測値が取得できた最新のものを使い、取得失敗が最新なら失敗を先に示す（失敗の下に古い値があっても現在値としない）。
 * 古い観測は値を出したうえで古いことを示す。
 */
export const metricHeadline = (metric: IntentMetric): MetricHeadline => {
  const { state, latest, lastObserved } = metric.current;
  const periodOf = (observation: MetricObservation) => (observation.periodStart === observation.periodEnd ? observation.periodEnd : `${observation.periodStart}〜${observation.periodEnd}`);
  if (state === "unmeasured" || latest === null) return { kind: "none", reason: "unmeasured" };
  if (state === "failed") {
    return {
      kind: "failed",
      reason: latest.failureReason,
      period: periodOf(latest),
      lastValue: lastObserved && lastObserved.value !== null ? { value: lastObserved.value, period: periodOf(lastObserved) } : null,
    };
  }
  if (lastObserved === null || lastObserved.value === null) return { kind: "stale_without_value" };
  return { kind: "value", value: lastObserved.value, period: periodOf(lastObserved), stale: state === "stale" };
};

export type ChartPoint = { date: string; x: number; y: number | null; failed: boolean; value: number | null };
export type ChartSegment = { points: { x: number; y: number }[] };

/**
 * 日次の推移の座標。横軸は範囲の暦日を等間隔、縦軸は0または最小値から最大値（目標値があれば目標値を含む）。
 * 線は連続する観測日だけを結び、観測の無い日・取得失敗の日をまたいで補間しない（別の線分に分ける）。
 */
export const chartGeometry = (
  points: DailyPoint[],
  window: { from: string; to: string },
  target: number | null,
  size: { width: number; height: number },
): { segments: ChartSegment[]; dots: ChartPoint[]; min: number; max: number; days: number } => {
  const days = Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / dayMilliseconds) + 1;
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const candidates = [...values, ...(target === null ? [] : [target])];
  const min = Math.min(0, ...(candidates.length ? candidates : [0]));
  const rawMax = Math.max(...(candidates.length ? candidates : [0]));
  const max = rawMax === min ? min + 1 : rawMax;
  const xOf = (date: string) => {
    const index = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / dayMilliseconds);
    return days <= 1 ? size.width / 2 : (index / (days - 1)) * size.width;
  };
  const yOf = (value: number) => size.height - ((value - min) / (max - min)) * size.height;
  const dots: ChartPoint[] = points.map((point) => ({ date: point.date, x: xOf(point.date), y: point.value === null ? null : yOf(point.value), failed: point.status === "failed", value: point.value }));
  const segments: ChartSegment[] = [];
  let previous: DailyPoint | null = null;
  for (const point of points) {
    if (point.value === null) {
      previous = null;
      continue;
    }
    const dot = { x: xOf(point.date), y: yOf(point.value) };
    const consecutive = previous !== null && Math.round((Date.parse(`${point.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`)) / dayMilliseconds) === 1;
    if (consecutive && segments.length > 0) segments[segments.length - 1]!.points.push(dot);
    else segments.push({ points: [dot] });
    previous = point;
  }
  return { segments, dots, min, max, days };
};

/** 推移を読み上げる要約。観測日数・範囲・最初と最後の値だけで、傾向（増加・改善等）を推測しない。 */
export const trendSummary = (metric: Pick<IntentMetric, "name" | "unit">, points: DailyPoint[], window: { from: string; to: string }): string => {
  const observed = points.filter((point) => point.value !== null);
  const failed = points.filter((point) => point.status === "failed").length;
  if (observed.length === 0) return `${metric.name}：${shortDate(window.from)}〜${shortDate(window.to)}に日次の観測値はありません${failed > 0 ? `（取得失敗${failed}日）` : ""}`;
  const first = observed[0]!;
  const last = observed[observed.length - 1]!;
  return `${metric.name}：${shortDate(window.from)}〜${shortDate(window.to)}の観測${observed.length}日${failed > 0 ? `、取得失敗${failed}日` : ""}。最初 ${shortDate(first.date)} ${formatMetricValue(first.value!, metric.unit)}、最後 ${shortDate(last.date)} ${formatMetricValue(last.value!, metric.unit)}`;
};
