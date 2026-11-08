import { Link } from "react-router-dom";
import type { Part } from "../../api";
import { workspaceIntentPath } from "../../paths";
import { MetricStateBadge, MetricTrend } from "./MetricTrend";
import { changeFromEarlier, formatDelta, formatMetricValue, metricHeadline, utcDate, type IntentMetric, type IntentMetrics } from "./metric";
import type { Intent } from "./intent";

/** 観測値の見出し（現在値・取得失敗・未計測）。値が無いときに0や達成を示さない。 */
export const MetricHeadlineView = ({ metric }: { metric: IntentMetric }) => {
  const headline = metricHeadline(metric);
  switch (headline.kind) {
    case "value":
      return <p className="metric-value"><strong>{formatMetricValue(headline.value, metric.unit)}</strong><small>{headline.period}の観測{headline.stale && <> ・ <MetricStateBadge metric={metric} /></>}</small></p>;
    case "none":
      return <p className="metric-value"><strong className="unset">—</strong><small><MetricStateBadge metric={metric} /> まだ観測値がありません</small></p>;
    case "failed":
      return (
        <p className="metric-value">
          <strong className="unset">—</strong>
          <small><MetricStateBadge metric={metric} /> {headline.period}の取得に失敗{headline.reason ? `（${headline.reason}）` : ""}。{headline.lastValue ? `最後に取得できた値は${headline.lastValue.period}の${formatMetricValue(headline.lastValue.value, metric.unit)}です。` : "取得できた値はありません。"}</small>
        </p>
      );
    case "stale_without_value":
      return <p className="metric-value"><strong className="unset">—</strong><small><MetricStateBadge metric={metric} /> 値を確認できません</small></p>;
  }
};

/** 目標値。未設定は「未設定」とし、説明文から補わない。 */
export const MetricTarget = ({ metric }: { metric: IntentMetric }) => (
  <p className="metric-target">{metric.targetValue === null ? "目標値は未設定" : `目標 ${formatMetricValue(metric.targetValue, metric.unit)}`}</p>
);

/**
 * 概要の目標カード。目標名から目標詳細へ移る。最初の観測項目の現在値・目標値・7日の推移を出し、
 * 観測値が無い・取得できない場合は理由を示す。Task・Outcomeの進み具合から達成を示さない。
 */
export const IntentGoalCard = ({ workspaceId, intent, metrics }: { workspaceId: string; intent: Intent; metrics: Part<IntentMetrics> | null }) => {
  const metric = metrics?.ok ? metrics.value.metrics[0] : undefined;
  const to = metrics?.ok ? utcDate(metrics.value.observedAt) : "";
  const change = metric ? changeFromEarlier(metric, 7) : null;
  return (
    <article className="goal-card" aria-label={intent.title}>
      <h3><Link to={workspaceIntentPath(workspaceId, intent.id)}>{intent.title}</Link></h3>
      {metrics === null ? <p role="status" className="unset">観測値を読み込み中...</p>
        : !metrics.ok ? <p role="alert" className="error-title">観測値を取得できません: {metrics.error}。目標の達成や未達は判断していません。</p>
        : !metric ? <p className="unset">観測項目が未定義です。値・推移は表示しません。</p>
        : (
          <>
            <p className="goal-card-metric">{metric.name}</p>
            <MetricHeadlineView metric={metric} />
            <MetricTarget metric={metric} />
            <MetricTrend metric={metric} to={to} days={7} compact />
            {change && <p className="metric-change">7日前（{change.from}）の観測との差 {formatDelta(change.delta, metric.unit)}</p>}
            {metrics.value.metrics.length > 1 && <p className="section-note">ほか{metrics.value.metrics.length - 1}指標は目標詳細で確認できます。</p>}
          </>
        )}
    </article>
  );
};
