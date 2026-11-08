import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button } from "../../components/ui";
import { projectViewPath, workspaceOutcomePath, workspacePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { ConfirmationView, ProblemSummaryView, TaskProgressView } from "./OutcomeOverviewParts";
import { conditionsSearch, emptyConditions, loadOutcomeOverviews, outcomePageSize, type OutcomeOverviewPage } from "./outcomeOverview";
import { outcomeStatusLabels, type Outcome } from "./outcome";

type Loaded = { key: string; page: OutcomeOverviewPage | null; error: string | null };
type ProjectLabel = { id: string; name: string };

/**
 * 目標詳細の関連Outcome。提供状況と効果の確認状況をTask進捗・止まっている問題と別の項目として並べ、
 * Outcome名からWorkspaceのOutcome詳細へ進める。一覧と同じserverの集計を使い、一部だけ表示するときは全件への導線を出す。
 */
export const IntentOutcomeSummaries = ({ workspaceId, intentId, projects }: { workspaceId: string; intentId: string; projects: ProjectLabel[] | null }) => {
  const key = `${workspaceId}/${intentId}`;
  const [state, setState] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadOutcomeOverviews(workspaceId, { ...emptyConditions, intentId })
      .then((page) => { if (active) setState({ key, page, error: null }); })
      .catch((reason: unknown) => { if (active) setState({ key, page: null, error: loadFailureMessage(classifyError(reason), "Outcomeが見つかりません。") }); });
    return () => { active = false; };
  }, [key, attempt]);
  const current = state?.key === key ? state : null;
  return (
    <section className="detail-section" aria-labelledby="intent-outcomes-heading">
      <h2 id="intent-outcomes-heading">関連するOutcome</h2>
      {!current ? <Loading /> : current.error ? (
        <><ErrorState message={`Outcomeの読み込みに失敗しました: ${current.error}`} /><Button variant="secondary" onClick={() => { setState(null); setAttempt((value) => value + 1); }}>再試行</Button></>
      ) : !current.page || current.page.total === 0 ? (
        <p className="unset">この目標に関連するOutcomeはまだありません。</p>
      ) : (
        <>
          <ul className="intent-outcome-list">
            {current.page.items.map((overview) => (
              <li key={overview.outcomeId} className="intent-outcome">
                <h3>
                  <Link to={workspaceOutcomePath(workspaceId, overview.intentId, overview.outcomeId)}>{overview.title}</Link>{" "}
                  {overview.status !== "active" && <span className={statusBadgeClass("muted")}>{outcomeStatusLabels[overview.status as Outcome["status"]] ?? overview.status}</span>}
                </h3>
                {overview.hypothesis && <p className="intent-outcome-hypothesis">{overview.hypothesis}</p>}
                <ConfirmationView delivery={overview.delivery} effect={overview.effect} />
                <div className="intent-outcome-meta">
                  <div><p className="outcome-cell-label">Task進捗</p><TaskProgressView progress={overview.progress} /></div>
                  <div><p className="outcome-cell-label">止まっている問題</p><ProblemSummaryView problems={overview.problems} /></div>
                </div>
                {overview.targets.length > 0 && (
                  <ul className="outcome-project-list" aria-label="関連Project">
                    {overview.targets.map((target) => {
                      const label = projects?.find(({ id }) => id === target.projectId);
                      return <li key={target.projectId}>{label ? <Link to={projectViewPath(target.projectId, "overview")}>{label.name}</Link> : <code>{target.projectId.slice(0, 8)}</code>}</li>;
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {current.page.total > outcomePageSize && (
            <p className="section-note">全{current.page.total}件のうち{current.page.items.length}件を表示しています。<Link to={`${workspacePath(workspaceId, "direction")}${conditionsSearch({ ...emptyConditions, intentId })}`}>Outcome一覧で全件を見る</Link></p>
          )}
        </>
      )}
    </section>
  );
};
