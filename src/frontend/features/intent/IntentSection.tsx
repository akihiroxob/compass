import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentStatusLabels, splitIntents, type Intent } from "../../intentForm";
import { intentPath } from "../../paths";
import { ActiveOutcomes } from "../outcome";
import { IntentFacts } from "./IntentFacts";

// ---- Intent（Step 2）。Strategist・Research・Outcomeは未実装のため、状態や進行を表示しない。 ----
/** `readOnly`（archivedのProject）では、登録・編集の導線を出さず、詳細の閲覧だけを残す。 */
export const IntentSection = ({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) => {
  const [intents, setIntents] = useState<Intent[] | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ intents: Intent[] }>(`/api/projects/${projectId}/intents`).then(({ intents }) => setIntents(intents)).catch((reason: unknown) => setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。"))); }, [projectId]);
  const { active, past } = splitIntents(intents ?? []);
  return <section className="detail-section intent-section" aria-labelledby="intent-heading"><h2 id="intent-heading">Intent</h2><p className="section-note">Humanが今実現したい状態です。Missionとは別に、達成や放棄で終わります。</p>
    {error ? <ErrorState message={`Intentの読み込みに失敗しました: ${error}`} /> : intents === null ? <Loading /> : <>
      {active ? <article className="intent-card"><span className="status-badge">{intentStatusLabels.active}</span><h3>{active.title}</h3><IntentFacts intent={active} /><ActiveOutcomes projectId={projectId} intentId={active.id} /><Link to={intentPath(projectId, active.id)} className="secondary-button">{readOnly ? "詳細" : "詳細・編集"}</Link></article> : <div className="intent-empty"><p className="unset">Intentは未登録です</p>{!readOnly && <Link to={intentPath(projectId, "new")} className="button">Intentを登録</Link>}</div>}
      {past.length > 0 && <details className="past-intents"><summary>過去のIntent（{past.length}件）</summary><ul>{past.map((intent) => <li key={intent.id}><Link to={intentPath(projectId, intent.id)}><span className="status-badge muted">{intentStatusLabels[intent.status]}</span> {intent.title}</Link></li>)}</ul></details>}
    </>}
  </section>;
};
