import { statusBadgeClass } from "../../statusTone";
import {
  chartGeometry,
  dailyPoints,
  formatMetricValue,
  metricStateLabels,
  shortDate,
  trendSummary,
  trendWindow,
  type IntentMetric,
  type TrendRange,
} from "./metric";

const chartSize = { width: 600, height: 120 };

/** 日次の観測の折れ線。観測の無い日・取得失敗の日をまたいで線を結ばず、取得失敗の日は軸上の赤い短い線で示す。 */
export const MetricTrend = ({ metric, to, days, compact = false }: { metric: IntentMetric; to: string; days: TrendRange; compact?: boolean }) => {
  const window = trendWindow(to, days);
  const { points, excluded } = dailyPoints(metric, window);
  const geometry = chartGeometry(points, window, metric.targetValue, chartSize);
  const failedDays = points.filter((point) => point.status === "failed");
  const targetY = metric.targetValue === null ? null : chartSize.height - ((metric.targetValue - geometry.min) / (geometry.max - geometry.min)) * chartSize.height;
  const hasValues = geometry.dots.some((dot) => dot.y !== null);
  return (
    <figure className={`metric-trend${compact ? " compact" : ""}`}>
      <div className="metric-trend-plot">
        {!compact && <div className="metric-trend-axis" aria-hidden="true"><span>{formatMetricValue(geometry.max, metric.unit)}</span><span>{formatMetricValue(geometry.min, metric.unit)}</span></div>}
        <svg viewBox={`-6 -6 ${chartSize.width + 12} ${chartSize.height + 18}`} role="img" aria-label={trendSummary(metric, points, window)} preserveAspectRatio="none">
          <line className="metric-trend-base" x1="0" x2={chartSize.width} y1={chartSize.height} y2={chartSize.height} />
          {targetY !== null && <line className="metric-trend-target" x1="0" x2={chartSize.width} y1={targetY} y2={targetY} />}
          {geometry.segments.map((segment, index) => segment.points.length > 1 && (
            <polyline key={index} className="metric-trend-line" points={segment.points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} />
          ))}
          {geometry.dots.map((dot) => dot.y === null
            ? <line key={dot.date} className="metric-trend-failed" x1={dot.x} x2={dot.x} y1={chartSize.height} y2={chartSize.height - 14} />
            : <line key={dot.date} className="metric-trend-dot" x1={dot.x} x2={dot.x + 0.01} y1={dot.y} y2={dot.y} />)}
        </svg>
      </div>
      <div className="metric-trend-dates" aria-hidden="true"><span>{shortDate(window.from)}</span><span>{shortDate(window.to)}</span></div>
      {!hasValues && <figcaption className="unset">{shortDate(window.from)}〜{shortDate(window.to)}に日次の観測値はありません。値のない日を0として描いていません。</figcaption>}
      {failedDays.length > 0 && <figcaption><span className={statusBadgeClass("warning")}>取得失敗 {failedDays.length}日</span> {failedDays.map((point) => `${shortDate(point.date)}${point.failureReason ? `（${point.failureReason}）` : ""}`).join("、")}。印の日は値を補っていません。</figcaption>}
      {excluded > 0 && <figcaption className="section-note">複数日にまたがる観測 {excluded}件は日次の推移に含めていません。</figcaption>}
      {hasValues && geometry.segments.length > 1 && <figcaption className="section-note">観測の無い日をまたぐ線は結んでいません。</figcaption>}
    </figure>
  );
};

/** 現在の観測状態のbadge。 */
export const MetricStateBadge = ({ metric }: { metric: IntentMetric }) => {
  const label = metricStateLabels[metric.current.state];
  return <span className={statusBadgeClass(label.tone)}>{label.label}</span>;
};
