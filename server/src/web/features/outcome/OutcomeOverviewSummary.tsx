import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, type Part } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button } from "../../components/ui";
import { projectViewPath } from "../../paths";
import { loadOutcomeOverview, type OutcomeOverview } from "./outcomeOverview";
import { ConfirmationView, ProblemList, TaskProgressView } from "./OutcomeOverviewParts";

type Loaded = { key: string; overview: OutcomeOverview | null; error: string | null };

/**
 * Outcome詳細のTask進捗と止まっている問題。一覧と同じserverの集計を読み、Projectごとの内訳と問題の全件を示す。
 * Task進捗は提供状況（公開）・効果（Evaluation）と別のもので、Outcomeの達成度ではない。
 */
export const OutcomeOverviewSummary = ({ workspaceId, outcomeId, projects }: { workspaceId: string; outcomeId: string; projects: Part<{ project: { id: string; name: string; status: string } }[]> }) => {
  const key = `${workspaceId}/${outcomeId}`;
  const [state, setState] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadOutcomeOverview(workspaceId, outcomeId)
      .then((overview) => { if (active) setState({ key, overview, error: null }); })
      .catch((reason: unknown) => { if (active) setState({ key, overview: null, error: loadFailureMessage(classifyError(reason), "Outcomeが見つかりません。") }); });
    return () => { active = false; };
  }, [key, attempt]);
  const current = state?.key === key ? state : null;
  const nameOf = (projectId: string) => (projects.ok ? projects.value.find(({ project }) => project.id === projectId)?.project : undefined);
  return (
    <section className="detail-section outcome-overview" aria-labelledby="outcome-overview-summary-heading">
      <h2 id="outcome-overview-summary-heading">提供状況・効果・Task進捗と止まっている問題</h2>
      <p className="section-note">Task進捗は受入済みTaskの割合です。提供状況（公開）やOutcomeの効果とは別で、達成度を示しません。効果は下の成功条件とEvaluationで確認します。</p>
      {!current ? <Loading /> : current.error ? (
        <><ErrorState message={`Task進捗と問題の読み込みに失敗しました: ${current.error}`} /><Button variant="secondary" onClick={() => { setState(null); setAttempt((value) => value + 1); }}>再試行</Button></>
      ) : !current.overview ? null : (
        <>
          <h3>提供状況と効果の確認</h3>
          <ConfirmationView delivery={current.overview.delivery} effect={current.overview.effect} />
          <h3>全Projectの集計</h3>
          <TaskProgressView progress={current.overview.progress} detail />
          {current.overview.progress.unplannedProjectCount > 0 && current.overview.progress.kind !== "no_target" && <p className="outcome-progress-note">未起票のProject {current.overview.progress.unplannedProjectCount}件（進捗の分母に含めていません）</p>}
          {current.overview.targets.length > 0 && (
            <>
              <h3>Project別</h3>
              <ul className="outcome-target-progress">
                {current.overview.targets.map((target) => {
                  const project = nameOf(target.projectId);
                  return (
                    <li key={target.projectId}>
                      <p>{project ? <Link to={projectViewPath(target.projectId, "work")}>{project.name}</Link> : <code>{target.projectId.slice(0, 8)}</code>}{(target.projectStatus === "archived" || project?.status === "archived") && <> <span className="status-badge muted">アーカイブ済み</span></>}</p>
                      <TaskProgressView progress={target.progress} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <h3>止まっている問題</h3>
          {current.overview.problems.state === "unknown" ? <p role="alert" className="error-title">問題の情報を取得できていません。問題なしではありません。</p>
            : current.overview.problems.state === "none" ? <p className="unset">待っている相談はありません。</p>
            : <><p className="outcome-progress-note">Human待ち {current.overview.problems.waitingHumanCount}件 / Agentが対処 {current.overview.problems.waitingAgentCount}件</p><ProblemList workspaceId={workspaceId} problems={current.overview.problems.items} /></>}
        </>
      )}
    </section>
  );
};
