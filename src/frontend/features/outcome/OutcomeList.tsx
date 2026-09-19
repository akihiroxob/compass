import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import type { Intent } from "../../intentForm";
import { outcomeStatusLabels, splitOutcomes, type Outcome } from "../../outcomeForm";
import { outcomePath } from "../../paths";

// ---- Outcome（Step 3）。Evaluation・Execution・Decision・Research・Strategistは未実装のため、達成率や進行状況を表示しない。 ----

/** IntentのOutcome一覧の取得。Project詳細とIntent詳細の両方が使う。 */
const useOutcomes = (projectId: string, intentId: string) => {
  const [state, setState] = useState<{ outcomes: Outcome[] | null; error: string | null }>({ outcomes: null, error: null });
  useEffect(() => { request<{ outcomes: Outcome[] }>(`/api/projects/${projectId}/intents/${intentId}/outcomes`).then(({ outcomes }) => setState({ outcomes, error: null })).catch((reason: unknown) => setState({ outcomes: null, error: loadFailureMessage(classifyError(reason), "ProjectまたはIntentが見つかりません。") })); }, [projectId, intentId]);
  return state;
};

const OutcomeLinks = ({ projectId, outcomes }: { projectId: string; outcomes: Outcome[] }) => <ul className="outcome-list">{outcomes.map((outcome) => <li key={outcome.id}><Link to={outcomePath(projectId, outcome.intentId, outcome.id)}><span className={`status-badge${outcome.status === "active" ? "" : " muted"}`}>{outcomeStatusLabels[outcome.status]}</span> {outcome.title}<small>成功条件 {outcome.successCriteria.length}件</small></Link></li>)}</ul>;

/** Project詳細のActive Intent内に表示する、ActiveなOutcomeの一覧。成功条件はOutcome詳細で見る。 */
export const ActiveOutcomes = ({ projectId, intentId }: { projectId: string; intentId: string }) => {
  const { outcomes, error } = useOutcomes(projectId, intentId); const { active } = splitOutcomes(outcomes ?? []);
  return <div className="outcome-block"><p className="section-label">Active Outcomes</p>{error ? <p className="unset" role="alert">Outcomeを読み込めませんでした: {error}</p> : outcomes === null ? <p className="unset" role="status">読み込み中...</p> : active.length ? <OutcomeLinks projectId={projectId} outcomes={active} /> : <p className="unset">Outcomeは未登録です</p>}</div>;
};

export const OutcomeSection = ({ projectId, intent }: { projectId: string; intent: Intent }) => {
  const { outcomes, error } = useOutcomes(projectId, intent.id); const { active, past } = splitOutcomes(outcomes ?? []);
  return <section className="detail-section" aria-labelledby="outcome-heading"><h2 id="outcome-heading">Outcome</h2><p className="section-note">Intentへ近づくために達成すべき、観測可能な状態です。Strategist（またはHuman）の判断結果として、成功条件とともに登録します。</p>
    {error ? <ErrorState message={`Outcomeの読み込みに失敗しました: ${error}`} /> : outcomes === null ? <Loading /> : <>
      {active.length ? <OutcomeLinks projectId={projectId} outcomes={active} /> : <p className="unset">{past.length ? "ActiveなOutcomeはありません" : "Outcomeは未登録です"}</p>}
      {intent.status === "active" && <div className="action-row"><Link to={outcomePath(projectId, intent.id, "new")} className="button">Outcomeを登録</Link></div>}
      {past.length > 0 && <details className="past-intents"><summary>取消済みなどのOutcome（{past.length}件）</summary><OutcomeLinks projectId={projectId} outcomes={past} /></details>}
    </>}</section>;
};
