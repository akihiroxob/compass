import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { directionDecisionTypeLabels, type DirectionDecision } from "../../directionDecisionForm";
import { outcomePath } from "../../paths";

const DecisionCard = ({ projectId, decision }: { projectId: string; decision: DirectionDecision }) => (
  <article className="intent-card">
    <h3>
      <span className="status-badge muted">{directionDecisionTypeLabels[decision.type]}</span>
    </h3>
    <p>{decision.judgment}</p>
    <p className="section-note">{decision.reason}</p>
    {decision.options.length > 0 && (
      <dl className="intent-facts">
        <dt>選択肢</dt>
        <dd>
          <ul>{decision.options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}</ul>
        </dd>
      </dl>
    )}
    {decision.outcomeId && (
      <p>
        <Link to={outcomePath(projectId, decision.intentId, decision.outcomeId)}>関連Outcomeを見る</Link>
      </p>
    )}
    <small>
      {new Date(decision.createdAt).toLocaleString("ja-JP")} 判断（{decision.principalId}）
    </small>
  </article>
);

/**
 * IntentのDirection Decision一覧（Human向け読み取り専用）。Strategist判断の来歴と、使用したSynthesis/Findingの
 * 参照を表示する。判断の作成はMCPからのみ行い、この画面からは作成・変更できない。
 */
export const DecisionSection = ({ projectId, intentId }: { projectId: string; intentId: string }) => {
  const [decisions, setDecisions] = useState<DirectionDecision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<{ decisions: DirectionDecision[] }>(`/api/projects/${projectId}/intents/${intentId}/decisions`)
      .then(({ decisions }) => setDecisions(decisions))
      .catch((reason: unknown) =>
        setError(loadFailureMessage(classifyError(reason), "ProjectまたはIntentが見つかりません。")),
      );
  }, [projectId, intentId]);
  return (
    <section className="detail-section" aria-labelledby="decision-heading">
      <h2 id="decision-heading">Direction Decision</h2>
      <p className="section-note">
        StrategistがIntent Briefを根拠に記録した判断です。正本はCompassで、この画面は参照専用です。
      </p>
      {error ? (
        <ErrorState message={`Direction Decisionの読み込みに失敗しました: ${error}`} />
      ) : decisions === null ? (
        <Loading />
      ) : decisions.length ? (
        decisions.map((decision) => <DecisionCard key={decision.id} projectId={projectId} decision={decision} />)
      ) : (
        <p className="unset">Direction Decisionは未登録です</p>
      )}
    </section>
  );
};
