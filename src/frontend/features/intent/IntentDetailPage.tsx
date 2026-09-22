import { Link, useParams } from "react-router-dom";
import { jsonPost, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import { intentStatusLabels, type Intent } from "../../intentForm";
import { intentPath } from "../../paths";
import { useProjectArchived } from "../../useProjectArchived";
import { DecisionSection } from "../decision";
import { OutcomeSection } from "../outcome";
import { IntentFacts } from "./IntentFacts";
import { useIntentPage } from "./useIntentPage";

export const IntentDetailPage = () => {
  const { projectId = "", intentId = "" } = useParams(); const { intent, error, setIntent } = useIntentPage(projectId, intentId); const archived = useProjectArchived(projectId); const editable = archived === false;
  const abandon = useReasonAction(
    async (reason) => setIntent((await request<{ intent: Intent }>(`/api/projects/${projectId}/intents/${intentId}/abandon`, jsonPost({ reason }))).intent),
    (classified) => classified.kind === "validation" ? classified.issues.map((issue) => `${issue.label}: ${issue.message}`).join(" / ") : classified.kind === "not_found" ? "Intentが見つかりません。" : classified.message,
  );
  return <Shell><main className="narrow"><Link to={`/projects/${projectId}`} className="back-link">← Project詳細</Link>{error ? <ErrorState message={error} /> : !intent ? <Loading /> : <>
    <div className="detail-hero"><p className="eyebrow">Intent</p><h1>{intent.title}</h1><p><span className={`status-badge${intent.status === "active" ? "" : " muted"}`}>{intentStatusLabels[intent.status]}</span></p><time>{new Date(intent.updatedAt).toLocaleString("ja-JP")} 更新</time></div>
    <section className="detail-section"><IntentFacts intent={intent} /></section>
    <OutcomeSection projectId={projectId} intent={intent} readOnly={!editable} />
    <DecisionSection projectId={projectId} intentId={intent.id} />
    {intent.status === "abandoned" && <section className="detail-section"><h2>放棄</h2><p>{intent.abandonedReason ?? <span className="unset">理由は記録されていません</span>}</p><p className="section-note">放棄したIntentはActiveに戻せません。{editable ? "続ける場合は新しいIntentを登録してください。" : ""}</p>{editable && <Link to={intentPath(projectId, "new")} className="secondary-button">新しいIntentを登録</Link>}</section>}
    {intent.status === "active" && editable && <div className="action-row"><Link to={intentPath(projectId, intent.id, "/edit")} className="button">Intentを編集</Link><button type="button" className="secondary-button danger" aria-expanded={abandon.confirming} onClick={abandon.open}>Intentを放棄</button></div>}
    {intent.status === "active" && editable && abandon.confirming && <ReasonPanel action={abandon} title="このIntentを放棄しますか？" description="放棄すると編集できず、Activeに戻せません。ActiveなOutcomeがあれば同時に取り消されます。新しいIntentを登録してやり直せます。" label="放棄の理由（任意）" confirmLabel="放棄する" pendingLabel="放棄中..." />}
  </>}</main></Shell>;
};
