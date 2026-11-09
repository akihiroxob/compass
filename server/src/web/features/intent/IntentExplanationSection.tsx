import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { outcomePath, researchRequestPath, workspaceApiPath, workspaceOutcomePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import {
  basisStateLabels,
  confidenceLabels,
  evaluationResultLabels,
  explanationPeriod,
  itemKindLabels,
  itemReferenceLabel,
  metricStateLabels,
  observationSummary,
  splitExplanationVersions,
  type ExplanationBasis,
  type ExplanationItem,
  type ExplanationItemKind,
  type ExplanationMetric,
  type IntentExplanation,
  type IntentExplanations,
} from "./explanation";

/** Outcomeの詳細。Project配下の画面からはProject配下、Workspaceの画面からはWorkspaceのOutcome詳細を開く。 */
const outcomeLink = (projectId: string | null, workspaceId: string, intentId: string, outcomeId: string) =>
  projectId ? outcomePath(projectId, intentId, outcomeId) : workspaceOutcomePath(workspaceId, intentId, outcomeId);

/** 調査はProject配下の画面でだけ開ける。開けるProjectが無ければ本文だけを出す。 */
const ResearchLink = ({ projectId, requestId, children }: { projectId: string | null; requestId: string; children: string }) =>
  projectId ? <Link to={researchRequestPath(projectId, requestId)}>{children}</Link> : <>{children}</>;

const BasisLine = ({ projectId, workspaceId, intentId, basis, unit }: { projectId: string | null; workspaceId: string; intentId: string; basis: ExplanationBasis; unit: string | null }) => {
  const outdated = basis.state !== "current" && <span className={statusBadgeClass("warning")}>{basisStateLabels[basis.state]}</span>;
  const content = (() => {
    if (basis.detail === null) return <>参照先の記録（{basis.type}）</>;
    switch (basis.type) {
      case "metric_observation":
        return <>{observationSummary(basis, unit)}</>;
      case "finding":
        return <><ResearchLink projectId={projectId} requestId={basis.detail.requestId}>調査結果</ResearchLink>：{basis.detail.statement}（{basis.detail.confidence}・観測 {new Date(basis.detail.observedAt).toLocaleDateString("ja-JP")}）</>;
      case "synthesis":
        return <><ResearchLink projectId={projectId} requestId={basis.detail.requestId}>{`調査の結論 v${basis.detail.version}`}</ResearchLink>：{basis.detail.conclusion}</>;
      case "evaluation":
        return <><Link to={outcomeLink(projectId, workspaceId, intentId, basis.detail.outcomeId)}>Outcomeの評価</Link>：{evaluationResultLabels[basis.detail.result]}（{basis.detail.method}）</>;
      case "decision":
        return basis.detail.outcomeId
          ? <><Link to={outcomeLink(projectId, workspaceId, intentId, basis.detail.outcomeId)}>Strategistの判断</Link>：{basis.detail.judgment}</>
          : <><a href="#decision-heading">Strategistの判断</a>：{basis.detail.judgment}</>;
    }
  })();
  return <li>{content} {outdated}</li>;
};

const ItemBlock = ({ projectId, workspaceId, intentId, items, item, unit }: { projectId: string | null; workspaceId: string; intentId: string; items: ExplanationItem[]; item: ExplanationItem; unit: string | null }) => (
  <li className="explanation-item">
    <p><strong>{itemReferenceLabel(items, item.position)}</strong> {item.statement}</p>
    {item.kind === "hypothesis" && item.confidence && (
      <p className="section-note">{confidenceLabels[item.confidence]}・確認方法：{item.verification}</p>
    )}
    {item.basedOn.length > 0 && <p className="section-note">元にする項目：{item.basedOn.map((position) => itemReferenceLabel(items, position)).join("・")}</p>}
    {item.basis.length > 0 && (
      <ul className="explanation-basis" aria-label="根拠">
        {item.basis.map((basis) => <BasisLine key={`${basis.type}:${basis.id}`} projectId={projectId} workspaceId={workspaceId} intentId={intentId} basis={basis} unit={unit} />)}
      </ul>
    )}
  </li>
);

const ExplanationCard = ({ projectId, workspaceId, explanation, metric }: { projectId: string | null; workspaceId: string; explanation: IntentExplanation; metric: ExplanationMetric | undefined }) => {
  const groups: ExplanationItemKind[] = ["fact", "hypothesis", "proposal"];
  return (
    <article className="intent-card explanation-card">
      <h3>
        {metric?.name ?? explanation.metricKey}
        <span className="explanation-meta">分析期間 {explanationPeriod(explanation)}</span>
        {metric && <span className={statusBadgeClass(metricStateLabels[metric.state].tone)}>{metricStateLabels[metric.state].label}</span>}
        {explanation.basisOutdated && <span className={statusBadgeClass("warning")}>根拠に古い記録あり</span>}
      </h3>
      <p className="section-note">
        v{explanation.version}・{new Date(explanation.createdAt).toLocaleString("ja-JP")} に {explanation.principalId} が記録。
        {explanation.previousId !== null && <> 前回からの変化：{explanation.changeFromPrevious ?? <span className="unset">記述なし</span>}</>}
        {explanation.previousId === null && " 初回の説明です。"}
      </p>
      {groups.map((kind) => {
        const items = explanation.items.filter((item) => item.kind === kind);
        return (
          <section key={kind} aria-label={itemKindLabels[kind]}>
            <h4>{itemKindLabels[kind]}</h4>
            {items.length === 0
              ? <p className="unset">{kind === "fact" ? "確認できた事実は記録されていません" : `${itemKindLabels[kind]}は記録されていません`}</p>
              : <ul className="explanation-items">{items.map((item) => <ItemBlock key={item.position} projectId={projectId} workspaceId={workspaceId} intentId={explanation.intentId} items={explanation.items} item={item} unit={metric?.unit ?? null} />)}</ul>}
          </section>
        );
      })}
      <h4>関連Outcome</h4>
      {explanation.relatedOutcomes.length === 0
        ? <p className="unset">関連づけられたOutcomeはありません</p>
        : <ul className="explanation-outcomes">{explanation.relatedOutcomes.map((outcome) => <li key={outcome.id}><Link to={outcomeLink(projectId, workspaceId, explanation.intentId, outcome.id)}>{outcome.title}</Link></li>)}</ul>}
    </article>
  );
};

/** 観測の取得状況。説明が無い理由（観測項目が未定義・未計測・取得失敗・古い観測）を、説明の不在と別に示す。 */
const MetricStatus = ({ metrics }: { metrics: ExplanationMetric[] }) =>
  metrics.length === 0
    ? <p className="unset">観測項目が定義されていないため、観測値に基づく説明の対象がありません。</p>
    : (
      <ul className="explanation-metrics" aria-label="観測の状態">
        {metrics.map((metric) => (
          <li key={metric.key}>
            {metric.name} <span className={statusBadgeClass(metricStateLabels[metric.state].tone)}>{metricStateLabels[metric.state].label}</span>
            {metric.lastObservedPeriodEnd && <small> 最新の観測 {metric.lastObservedPeriodEnd}</small>}
          </li>
        ))}
      </ul>
    );

/**
 * 目標（Intent）の観測についてのAgentの説明（Human向け読み取り専用）。事実・原因の仮説・次の提案を分け、対象期間・根拠・関連Outcomeを示す。
 * 記録が無いときは「未記録」とし、観測値から説明を生成しない。説明の記録はAgentの実稼働や目標達成の証拠ではない。
 */
export const IntentExplanationSection = ({ projectId, workspaceId, intentId }: { projectId: string | null; workspaceId: string; intentId: string }) => {
  const [state, setState] = useState<{ data: IntentExplanations | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    setState({ data: null, error: null });
    request<IntentExplanations>(workspaceApiPath(workspaceId, `/intents/${intentId}/explanations`))
      .then((data) => setState({ data, error: null }))
      .catch((reason: unknown) => setState({ data: null, error: loadFailureMessage(classifyError(reason), "WorkspaceまたはIntentが見つかりません。") }));
  }, [workspaceId, intentId]);
  const { data, error } = state;
  const { latest, earlier } = splitExplanationVersions(data?.explanations ?? []);
  return (
    <section className="detail-section" aria-labelledby="explanation-heading">
      <h2 id="explanation-heading">Agentの説明</h2>
      {error ? <ErrorState message={`Agentの説明の読み込みに失敗しました: ${error}`} /> : data === null ? <Loading /> : <>
        <MetricStatus metrics={data.metrics} />
        {data.explanations.length === 0
          ? <p className="unset">説明はまだ記録されていません。</p>
          : latest.map((explanation) => <ExplanationCard key={explanation.id} projectId={projectId} workspaceId={workspaceId} explanation={explanation} metric={data.metrics.find((metric) => metric.key === explanation.metricKey)} />)}
        {earlier.length > 0 && (
          <details className="past-intents">
            <summary>過去の版（{earlier.length}件）</summary>
            <ul className="revision-list">
              {earlier.map((explanation) => (
                <li key={explanation.id}>
                  <strong>{data.metrics.find((metric) => metric.key === explanation.metricKey)?.name ?? explanation.metricKey} v{explanation.version}</strong>
                  <small> 分析期間 {explanationPeriod(explanation)}・{new Date(explanation.createdAt).toLocaleString("ja-JP")}・{explanation.principalId}</small>
                </li>
              ))}
            </ul>
          </details>
        )}
      </>}
    </section>
  );
};
