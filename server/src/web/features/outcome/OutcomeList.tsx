import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { outcomePath, workspaceApiPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import type { ProjectOperationAccess } from "../access";
import { isReplanTarget, outcomeEmptyMessage, outcomeStatusLabels, splitOutcomes, type Outcome } from "./outcome";
import { LinkButton } from "../../components/ui";

// ---- Outcome（Step 3）。Evaluation・Execution・Decision・Research・Strategistは未実装のため、達成率や進行状況を表示しない。 ----

/** 所属WorkspaceのIntentのOutcome一覧の取得。Project詳細とIntent詳細の両方が使う。syncKeyが変わると再取得する（Intentの放棄・意味更新など、Outcomeの状態へ波及する操作の後）。 */
const useOutcomes = (workspaceId: string, intentId: string, syncKey = "") => {
  const [state, setState] = useState<{ outcomes: Outcome[] | null; error: string | null }>({ outcomes: null, error: null });
  useEffect(() => { request<{ outcomes: Outcome[] }>(workspaceApiPath(workspaceId, `/intents/${intentId}/outcomes`)).then(({ outcomes }) => setState({ outcomes, error: null })).catch((reason: unknown) => setState({ outcomes: null, error: loadFailureMessage(classifyError(reason), "WorkspaceまたはIntentが見つかりません。") })); }, [workspaceId, intentId, syncKey]);
  return state;
};

const OutcomeLinks = ({ projectId, outcomes, meaningVersion }: { projectId: string; outcomes: Outcome[]; meaningVersion?: number }) => <ul className="outcome-list">{outcomes.map((outcome) => <li key={outcome.id}><Link to={outcomePath(projectId, outcome.intentId, outcome.id)}><span className={statusBadgeClass(outcome.status === "active" ? "progress" : "muted")}>{outcomeStatusLabels[outcome.status]}</span> {outcome.title}{meaningVersion !== undefined && isReplanTarget(outcome, { meaningVersion }) && <> <span className={statusBadgeClass("warning")}>再計画対象</span></>}<small>成功条件 {outcome.successCriteria.length}件 ・ 目標 v{outcome.intentVersion}</small></Link></li>)}</ul>;

/** Project詳細のActive Intent内に表示する、ActiveなOutcomeの一覧。成功条件はOutcome詳細で見る。 */
export const ActiveOutcomes = ({ projectId, workspaceId, intentId, meaningVersion }: { projectId: string; workspaceId: string; intentId: string; meaningVersion?: number }) => {
  const { outcomes, error } = useOutcomes(workspaceId, intentId); const { active } = splitOutcomes(outcomes ?? []);
  return <div className="outcome-block"><p className="section-label">Active Outcomes</p>{error ? <p className="unset" role="alert">Outcomeを読み込めませんでした: {error}</p> : outcomes === null ? <p className="unset" role="status">読み込み中...</p> : active.length ? <OutcomeLinks projectId={projectId} outcomes={active} meaningVersion={meaningVersion} /> : <p className="unset">Active Outcomeはまだありません</p>}</div>;
};

export const OutcomeSection = ({ projectId, workspaceId, intent, access }: { projectId: string; workspaceId: string; intent: { id: string; status: string; meaningVersion?: number }; access: ProjectOperationAccess | "loading" | "error" }) => {
  const readOnly = access !== "allowed";
  const { outcomes, error } = useOutcomes(workspaceId, intent.id, `${intent.status}:${intent.meaningVersion ?? ""}`); const { active, past } = splitOutcomes(outcomes ?? []);
  return <section className="detail-section" aria-labelledby="outcome-heading"><h2 id="outcome-heading">Outcome</h2><p className="section-note">Intentへ近づくために達成すべき、観測可能な状態です。Strategist（またはHuman）の判断結果として、成功条件とともに登録します。</p>
    {error ? <ErrorState message={`Outcomeの読み込みに失敗しました: ${error}`} /> : outcomes === null ? <Loading /> : <>
      {active.length ? <OutcomeLinks projectId={projectId} outcomes={active} meaningVersion={intent.meaningVersion} /> : <p className="unset">{outcomeEmptyMessage(intent.status, access, past.length > 0)}</p>}
      {intent.status === "active" && !readOnly && <div className="action-row"><LinkButton to={outcomePath(projectId, intent.id, "new")}>Outcomeを登録</LinkButton></div>}
      {past.length > 0 && <details className="past-intents"><summary>取消済みなどのOutcome（{past.length}件）</summary><OutcomeLinks projectId={projectId} outcomes={past} /></details>}
    </>}</section>;
};
