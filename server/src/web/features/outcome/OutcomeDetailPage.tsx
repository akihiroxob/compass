import { Link, useParams } from "react-router-dom";
import { jsonPost, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import { outcomeStatusLabels, type Outcome } from "../../outcomeForm";
import { intentPath, outcomePath, workspaceApiPath } from "../../paths";
import { useProjectWorkspaceDirection } from "../../useWorkspaceDirection";
import { statusBadgeClass } from "../../statusTone";
import { OutcomeLoopSection } from "./OutcomeLoopSection";
import { useOutcomePage } from "./useOutcomePage";

export const OutcomeDetailPage = () => {
  const { projectId = "", intentId = "", outcomeId = "" } = useParams(); const direction = useProjectWorkspaceDirection(projectId); const { workspaceId } = direction;
  const page = useOutcomePage(workspaceId, intentId, outcomeId); const { outcome, setOutcome } = page; const error = direction.access === "error" ? direction.message : page.error; const editable = direction.access === "allowed";
  const cancel = useReasonAction(
    async (reason) => { if (workspaceId !== null) setOutcome((await request<{ outcome: Outcome }>(workspaceApiPath(workspaceId, `/intents/${intentId}/outcomes/${outcomeId}/cancel`), jsonPost({ reason }))).outcome); },
    (classified) => classified.kind === "validation" ? classified.issues.map((issue) => `取消の理由: ${issue.message}`).join(" / ") : classified.kind === "not_found" ? "Outcomeが見つかりません。" : classified.message,
  );
  return <Shell><main className="narrow"><Link to={intentPath(projectId, intentId)} className="back-link">← Intent詳細</Link>{error ? <ErrorState message={error} /> : !outcome ? <Loading /> : <>
    <div className="detail-hero"><p className="eyebrow">Outcome</p><h1>{outcome.title}</h1><p><span className={statusBadgeClass(outcome.status === "active" ? "progress" : "muted")}>{outcomeStatusLabels[outcome.status]}</span></p><time>{new Date(outcome.updatedAt).toLocaleString("ja-JP")} 更新</time></div>
    <section className="detail-section"><dl className="intent-facts"><dt>達成すべき状態</dt><dd>{outcome.description}</dd><dt>仮説</dt><dd>{outcome.hypothesis ?? <span className="unset">未設定</span>}</dd><dt>判断理由（Strategistの判断）</dt><dd>{outcome.rationale}</dd></dl></section>
    <section className="detail-section" aria-labelledby="criteria-heading"><h2 id="criteria-heading">成功条件</h2><p className="section-note">成功条件は作成時に固定されます。変更する場合は、このOutcomeを取り消して新しいOutcomeを作成します。</p><ol className="criteria-list">{outcome.successCriteria.map((criterion) => <li key={criterion.id}><p className="criterion-title">{criterion.description}</p><dl><dt>測定方法</dt><dd>{criterion.measurement}</dd>{criterion.target && <><dt>目標値</dt><dd>{criterion.target}</dd></>}</dl></li>)}</ol></section>
    <OutcomeLoopSection projectId={projectId} workspaceId={outcome.workspaceId} intentId={intentId} outcomeId={outcome.id} />
    {outcome.status === "cancelled" && <section className="detail-section"><h2>取消</h2><p>{outcome.cancelReason}</p><p className="section-note">取り消したOutcomeはActiveに戻せません。{editable ? "続ける場合は新しいOutcomeを登録してください。" : ""}</p></section>}
    {outcome.status === "active" && editable && <div className="action-row"><Link to={outcomePath(projectId, intentId, outcome.id, "/edit")} className="button">タイトル・仮説を編集</Link><button type="button" className="secondary-button danger" aria-expanded={cancel.confirming} onClick={cancel.open}>Outcomeを取消</button></div>}
    {outcome.status === "active" && editable && cancel.confirming && <ReasonPanel action={cancel} title="このOutcomeを取り消しますか？" description="取り消すと編集できず、Activeに戻せません。成功条件を変えたい場合は、新しいOutcomeを登録してやり直せます。" label={<>取消の理由 <span>必須</span></>} required confirmLabel="取り消す" pendingLabel="取消中..." />}
  </>}</main></Shell>;
};
