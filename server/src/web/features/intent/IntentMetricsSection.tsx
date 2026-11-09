import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, ViewSwitch } from "../../components/ui";
import { MetricHeadlineView, MetricTarget } from "./IntentGoalCard";
import { MetricStateBadge, MetricTrend } from "./MetricTrend";
import { loadIntentMetrics } from "./metricData";
import { changeFromEarlier, formatDelta, trendRangeLabels, trendRanges, utcDate, type IntentMetric, type IntentMetrics, type TrendRange } from "./metric";

const parseRange = (value: string | null): TrendRange => (trendRanges.find((range) => String(range) === value) ?? 7);

/** 1つの観測項目。現在値・目標値と、選んだ期間の日次の推移。値が無い・取得できないときも理由を示す。 */
const MetricPanel = ({ metric, to, days, rangeSwitch }: { metric: IntentMetric; to: string; days: TrendRange; rangeSwitch: ReactNode }) => {
  const change = changeFromEarlier(metric, days);
  return (
    <article className="metric-panel" aria-label={metric.name}>
      <div className="metric-panel-head">
        <div>
          <h3>{metric.name} <MetricStateBadge metric={metric} /></h3>
          <MetricHeadlineView metric={metric} />
          <MetricTarget metric={metric} />
          {change && <p className="metric-change">{days}日前（{change.from}）の観測との差 {formatDelta(change.delta, metric.unit)}</p>}
        </div>
        {rangeSwitch}
      </div>
      <MetricTrend metric={metric} to={to} days={days} />
    </article>
  );
};

/**
 * 目標詳細の「観測値の推移」。観測項目ごとの現在値・目標値と、7日／30日（URLの`?range=`）の日次の推移。
 * 値の無い期間・取得失敗・観測項目の未定義を、目標の達成・未達や0として扱わない。
 */
export const IntentMetricsSection = ({ workspaceId, intentId }: { workspaceId: string; intentId: string }) => {
  const [search] = useSearchParams();
  const days = parseRange(search.get("range"));
  const key = `${workspaceId}/${intentId}`;
  const [state, setState] = useState<{ key: string; metrics: IntentMetrics | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadIntentMetrics(workspaceId, intentId)
      .then((metrics) => { if (active) setState({ key, metrics, error: null }); })
      .catch((reason: unknown) => { if (active) setState({ key, metrics: null, error: loadFailureMessage(classifyError(reason), "目標が見つかりません。") }); });
    return () => { active = false; };
  }, [key, attempt]);
  const current = state?.key === key ? state : null;
  const switchFor = (
    <ViewSwitch
      label="推移の期間"
      size="sm"
      items={trendRanges.map((range) => ({ key: String(range), to: { search: range === 7 ? "" : `?range=${range}` }, label: trendRangeLabels[range], current: range === days }))}
    />
  );
  return (
    <section className="detail-section" aria-labelledby="intent-metrics-heading">
      <h2 id="intent-metrics-heading">観測値の推移</h2>
      {!current ? <Loading /> : current.error ? (
        <><ErrorState message={`観測値の読み込みに失敗しました: ${current.error}。取得できていないため、目標の達成・未達は判断していません。`} /><Button variant="secondary" onClick={() => { setState(null); setAttempt((value) => value + 1); }}>再試行</Button></>
      ) : !current.metrics || current.metrics.metrics.length === 0 ? (
        <p className="unset">観測項目が定義されていないため、値と推移は表示しません。Taskの受入やOutcomeの状態から目標の到達を推測しません。</p>
      ) : (
        <div className="metric-panels">
          {current.metrics.metrics.map((metric) => <MetricPanel key={metric.id} metric={metric} to={utcDate(current.metrics!.observedAt)} days={days} rangeSwitch={switchFor} />)}
        </div>
      )}
    </section>
  );
};
