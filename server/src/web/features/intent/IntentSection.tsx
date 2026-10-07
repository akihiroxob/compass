import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentStatusLabels, splitIntents, type Intent } from "../../intentForm";
import { intentPath, workspaceApiPath } from "../../paths";
import { registrationUnavailableNote, type ProjectOperationAccess } from "../../projectAccess";
import { statusBadgeClass } from "../../statusTone";
import { ActiveOutcomes } from "../outcome";
import { IntentFacts } from "./IntentFacts";

// ---- Intent（Step 2）。Strategist・Research・Outcomeは未実装のため、状態や進行を表示しない。 ----
/**
 * Project画面に、所属WorkspaceのIntentを表示する。`access`はWorkspaceのstatusとWorkspace Membershipから決め、
 * `allowed`以外（archived・権限なし）では登録・編集の導線を出さず、詳細の閲覧と依頼先の案内だけを残す。
 */
export const IntentSection = ({ projectId, workspaceId, access }: { projectId: string; workspaceId: string; access: ProjectOperationAccess }) => {
  const readOnly = access !== "allowed"; const unavailable = registrationUnavailableNote(access, "Intent", "Workspace");
  const [intents, setIntents] = useState<Intent[] | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ intents: Intent[] }>(workspaceApiPath(workspaceId, "/intents")).then(({ intents }) => setIntents(intents)).catch((reason: unknown) => setError(loadFailureMessage(classifyError(reason), "Workspaceが見つかりません。"))); }, [workspaceId]);
  const { active, past } = splitIntents(intents ?? []);
  return <section className="detail-section intent-section" aria-labelledby="intent-heading"><h2 id="intent-heading">Intent</h2><p className="section-note">Humanが今実現したい状態です。所属WorkspaceのIntentで、同じWorkspaceのProjectで共有します。Missionとは別に、達成や放棄で終わります。</p>
    {error ? <ErrorState message={`Intentの読み込みに失敗しました: ${error}`} /> : intents === null ? <Loading /> : <>
      {active ? <article className="intent-card"><span className={statusBadgeClass("progress")}>{intentStatusLabels.active}</span><h3>{active.title}</h3><IntentFacts intent={active} /><ActiveOutcomes projectId={projectId} workspaceId={workspaceId} intentId={active.id} /><Link to={intentPath(projectId, active.id)} className="secondary-button">{readOnly ? "詳細" : "詳細・編集"}</Link></article> : <div className="intent-empty"><p className="unset">{past.length ? "ActiveなIntentはありません。" : access === "archived" ? "Intentはありません。" : "Intentはまだありません。今実現したい状態をIntentとして登録すると、Strategistが進め方を判断します。"}</p>{unavailable && <p className="section-note">{unavailable}</p>}{!readOnly && <Link to={intentPath(projectId, "new")} className="button">Intentを登録</Link>}</div>}
      {past.length > 0 && <details className="past-intents"><summary>過去のIntent（{past.length}件）</summary><ul>{past.map((intent) => <li key={intent.id}><Link to={intentPath(projectId, intent.id)}><span className="status-badge muted">{intentStatusLabels[intent.status]}</span> {intent.title}</Link></li>)}</ul></details>}
    </>}
  </section>;
};
