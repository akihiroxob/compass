import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { request, settle } from "../../api";
import { StateCard, Loading } from "../../components/StateCard";
import { Button, LinkButton } from "../../components/ui";
import { workspaceApiPath, workspaceCreatePath, workspacePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { problemKindLabels, type OutcomeOverviewPage } from "../outcome";
import type { InboxPage } from "../consultation";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import type { Workspace } from "./workspace";
import { summarizeWaiting, summarizeWorkspaceProblems, waitingCountPath, waitingCountText, type WaitingCount, type WorkspaceProblems } from "./workspaceComparison";

type Comparison = { problems: WorkspaceProblems; waiting: WaitingCount };

const loadComparison = async (workspaceId: string): Promise<Comparison> => {
  const [outcomes, waiting] = await Promise.all([
    settle(request<OutcomeOverviewPage>(workspaceApiPath(workspaceId, "/outcomes?limit=100")), "Workspaceが見つかりません。"),
    settle(request<InboxPage>(waitingCountPath(workspaceId)), "Workspaceが見つかりません。"),
  ]);
  return { problems: summarizeWorkspaceProblems(outcomes.ok ? outcomes.value : null), waiting: summarizeWaiting(waiting.ok ? waiting.value : null) };
};

/** 問題の代表の理由と「ほかN件」。取得できない・対象が無い場合も問題なしと区別する。 */
const ProblemsCell = ({ workspace, problems }: { workspace: Workspace; problems: WorkspaceProblems | null }) => {
  if (problems === null) return <p role="status" className="unset">読み込み中...</p>;
  switch (problems.state) {
    case "unknown":
      return <><span className={statusBadgeClass("warning")}>未取得</span><p className="workspace-card-reason">問題の情報を取得できていません。問題なしではありません。</p></>;
    case "no_outcomes":
      return <><span className={statusBadgeClass("muted")}>対象なし</span><p className="workspace-card-reason">Outcomeがまだないため、問題の有無は判定できません。</p></>;
    case "none":
      return <span className={statusBadgeClass("muted")}>問題なし</span>;
    case "present":
      return (
        <>
          <span className={statusBadgeClass("attention")}>問題あり</span>
          <p className="workspace-card-reason"><span className="workspace-card-kind">{problemKindLabels[problems.representative.kind]}</span> {problems.representative.reason}</p>
          {problems.otherCount > 0 && <p className="workspace-card-other"><Link to={`${workspacePath(workspace.id, "direction")}?problem=present`}>ほか{problems.otherCount}件</Link></p>}
          {problems.unconfirmed > 0 && <p className="section-note">問題を確認できないOutcomeが{problems.unconfirmed}件あります。</p>}
          {problems.truncated && <p className="section-note">Outcomeが多いため一部だけを確認しています。</p>}
        </>
      );
  }
};

const WaitingCell = ({ workspace, waiting }: { workspace: Workspace; waiting: WaitingCount | null }) => (
  <>
    <p className="workspace-card-label">対応待ち</p>
    {waiting === null ? <p role="status" className="unset">読み込み中...</p> : (
      <Link className="workspace-card-count" to={workspacePath(workspace.id, "consultations")} aria-label={waiting.state === "unknown" ? "対応待ちの件数を取得できません" : `対応待ち ${waitingCountText(waiting)}件`}>
        <strong className={waiting.state === "counted" && waiting.count === 0 ? "zero" : undefined}>{waitingCountText(waiting)}</strong>{waiting.state === "counted" && <> 件</>}
      </Link>
    )}
    {waiting?.state === "unknown" && <p className="section-note">件数を取得できません。0件ではありません。</p>}
  </>
);

const WorkspaceCard = ({ workspace }: { workspace: Workspace }) => {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setComparison(null);
    void loadComparison(workspace.id).then((loaded) => { if (active) setComparison(loaded); });
    return () => { active = false; };
  }, [workspace.id, workspace.updatedAt, attempt]);
  return (
    <article className="workspace-card" aria-label={workspace.name}>
      <div className="workspace-card-main">
        <h2><Link to={workspacePath(workspace.id)}>{workspace.name}</Link></h2>
        <dl>
          <div><dt>Mission</dt><dd>{workspace.mission}</dd></div>
          <div><dt>Vision</dt><dd className="workspace-card-vision">{workspace.vision ?? <span className="unset">未設定</span>}</dd></div>
        </dl>
      </div>
      <div className="workspace-card-problems"><ProblemsCell workspace={workspace} problems={comparison?.problems ?? null} /></div>
      <div className="workspace-card-waiting"><WaitingCell workspace={workspace} waiting={comparison?.waiting ?? null} />
        {comparison && (comparison.problems.state === "unknown" || comparison.waiting.state === "unknown") && <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>再取得</Button>}
      </div>
    </article>
  );
};

/** Workspace一覧（ホーム）。各WorkspaceのMission・最大2行のVision・問題・対応待ちを比べ、Workspace名から概要へ移る。 */
export const WorkspaceList = () => {
  const navigation = useWorkspaceNavigation();
  if (!navigation || navigation.error) {
    return <main><StateCard tone="error" role="alert"><p>Workspaceの一覧を読み込めませんでした: {navigation?.error ?? "不明なエラー"}</p>{navigation && <Button variant="secondary" onClick={navigation.reload}>再試行</Button>}</StateCard></main>;
  }
  const { workspaces } = navigation;
  if (workspaces === null) return <main><Loading /></main>;
  return (
    <main>
      <div className="detail-hero workspace-list-hero">
        <h1>Workspace</h1>
        {workspaces.length > 0 && <div className="action-row"><LinkButton variant="secondary" size="sm" to={workspaceCreatePath}>Workspaceを作成</LinkButton></div>}
      </div>
      {workspaces.length === 0 ? (
        <StateCard>
          <p>参加しているWorkspaceはありません。Workspaceは、Mission・Visionを共有して複数のProjectで成果を実現する単位です。Workspaceを作成するとあなたがownerになり、Projectを追加できます。</p>
          <p>既存のWorkspaceに参加するには、そのWorkspaceのownerにMembershipの追加を依頼してください。</p>
          <div className="action-row"><LinkButton to={workspaceCreatePath}>Workspaceを作成</LinkButton><LinkButton variant="secondary" to="/projects">参加中のProject</LinkButton></div>
        </StateCard>
      ) : (
        <section className="workspace-cards" aria-label={`${workspaces.length}件のWorkspace`}>
          {workspaces.map((workspace) => <WorkspaceCard key={workspace.id} workspace={workspace} />)}
        </section>
      )}
    </main>
  );
};
