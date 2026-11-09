import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { request, settle, type Part } from "../../api";
import { Loading, ErrorState } from "../../components/StateCard";
import { Button, LinkButton } from "../../components/ui";
import { projectViewPath, workspaceApiPath, workspaceIntentCreatePath, workspaceProjectCreatePath, workspacePath, workspaceIntentPath } from "../../paths";
import { canOperateWorkspace } from "../access";
import type { InboxPage } from "../consultation";
import { WorkCounts, type TargetWork } from "../direction";
import { formatTime } from "../execution";
import {
  IntentGoalCard,
  itemKindLabels,
  loadIntentExplanations,
  loadIntentMetrics,
  splitExplanationVersions,
  type Intent,
  type IntentExplanation,
  type IntentExplanations,
  type IntentMetrics,
} from "../intent";
import type { HumanRole } from "../member";
import { emptyProjectNote, type Workspace } from "./workspace";
import { summarizeWaiting, waitingCountPath, waitingCountText, type WaitingCount } from "./workspaceComparison";
import { loadProjects, type OverviewProject } from "./workspaceProjects";
import { statusBadgeClass } from "../../statusTone";

type GoalData = { intent: Intent; metrics: Part<IntentMetrics>; explanations: Part<IntentExplanations> };

type OverviewData = {
  /** Active Intent（目標）。取得できなければエラー。 */
  goals: Part<GoalData[]>;
  projects: Part<OverviewProject[]>;
  waiting: WaitingCount;
  fetchedAt: number;
};

const notFound = "Workspaceが見つからないか、閲覧する権限がありません。";

const loadOverview = async (workspaceId: string): Promise<OverviewData> => {
  const [intents, projects, waiting] = await Promise.all([
    settle(request<{ intents: Intent[] }>(workspaceApiPath(workspaceId, "/intents")).then(({ intents }) => intents.filter((intent) => intent.status === "active")), notFound),
    settle(loadProjects(workspaceId), notFound),
    settle(request<InboxPage>(waitingCountPath(workspaceId)), notFound),
  ]);
  const goals: Part<GoalData[]> = intents.ok
    ? {
        ok: true,
        value: await Promise.all(intents.value.map(async (intent) => {
          const [metrics, explanations] = await Promise.all([
            settle(loadIntentMetrics(workspaceId, intent.id), notFound),
            settle(loadIntentExplanations(workspaceId, intent.id), notFound),
          ]);
          return { intent, metrics, explanations };
        })),
      }
    : intents;
  return { goals, projects, waiting: summarizeWaiting(waiting.ok ? waiting.value : null), fetchedAt: Date.now() };
};

/** Project名とリンク。一覧を取得できなければIDだけを出す。 */
export const ProjectName = ({ projectId, projects, view }: { projectId: string; projects: Part<OverviewProject[]>; view: "overview" | "work" }) => {
  const found = projects.ok ? projects.value.find(({ project }) => project.id === projectId) : undefined;
  if (!found) return <code>{projectId.slice(0, 8)}</code>;
  return (
    <>
      <Link to={projectViewPath(projectId, view)}>{found.project.name}</Link>
      {found.project.status === "archived" && <> <span className="status-badge muted">アーカイブ済み</span></>}
    </>
  );
};

export const openProjects = (projects: Part<OverviewProject[]>) =>
  projects.ok ? projects.value.map(({ project }) => ({ id: project.id, status: project.status })) : [];

export const TargetRow = ({ target, projects }: { target: TargetWork; projects: Part<OverviewProject[]> }) => (
  <li>
    <ProjectName projectId={target.projectId} projects={projects} view="work" />
    <WorkCounts work={target.work} />
  </li>
);


const summaryKinds = ["fact", "hypothesis", "proposal"] as const;

/** 目標1つの最新のAgentの説明。事実・原因の仮説・次の提案を分け、根拠・版は目標詳細で読む。 */
const SummaryCard = ({ workspaceId, goal }: { workspaceId: string; goal: GoalData }) => {
  const { intent, explanations } = goal;
  const heading = <h3><Link to={workspaceIntentPath(workspaceId, intent.id)}>{intent.title}</Link></h3>;
  if (!explanations.ok) return <article className="summary-card">{heading}<p role="alert" className="error-title">Agentの説明を取得できません: {explanations.error}</p></article>;
  const { latest } = splitExplanationVersions(explanations.value.explanations);
  const newest: IntentExplanation | undefined = latest[0];
  if (!newest) return <article className="summary-card">{heading}<p className="unset">Agentの説明はまだ記録されていません。観測値から説明は作っていません。</p></article>;
  const metricName = explanations.value.metrics.find((metric) => metric.key === newest.metricKey)?.name ?? newest.metricKey;
  return (
    <article className="summary-card">
      {heading}
      <p className="section-note">{metricName}・分析期間 {newest.periodStart === newest.periodEnd ? newest.periodStart : `${newest.periodStart}〜${newest.periodEnd}`}{newest.basisOutdated && <> <span className={statusBadgeClass("warning")}>根拠に古い記録あり</span></>}</p>
      <div className="summary-kinds">
        {summaryKinds.map((kind) => {
          const items = newest.items.filter((item) => item.kind === kind);
          return (
            <section key={kind} aria-label={itemKindLabels[kind]}>
              <h4>{itemKindLabels[kind]}</h4>
              {items.length === 0 ? <p className="unset">記録されていません</p> : <ul>{items.map((item) => <li key={item.position}>{item.statement}</li>)}</ul>}
            </section>
          );
        })}
      </div>
      {latest.length > 1 && <p className="section-note">ほか{latest.length - 1}件の観測項目の説明は目標詳細で確認できます。</p>}
    </article>
  );
};

const CurrentSummary = ({ workspaceId, goals }: { workspaceId: string; goals: Part<GoalData[]> }) => {
  if (!goals.ok) return <ErrorState message={`目標の読み込みに失敗しました: ${goals.error}`} />;
  if (goals.value.length === 0) return <p className="unset">目標が未登録のため、現状の概要はありません。</p>;
  return <div className="summary-cards">{goals.value.map((goal) => <SummaryCard key={goal.intent.id} workspaceId={workspaceId} goal={goal} />)}</div>;
};

const Goals = ({ workspace, canWrite, goals }: { workspace: Workspace; canWrite: boolean; goals: Part<GoalData[]> }) => {
  if (!goals.ok) return <ErrorState message={`目標の読み込みに失敗しました: ${goals.error}`} />;
  if (goals.value.length === 0) {
    return (
      <>
        <p className="unset">ビジネス目標は未登録です。{canWrite ? "目標を作成すると、観測値と推移をここで比べられます。" : "登録はWorkspaceのeditor以上に依頼してください。"}</p>
      </>
    );
  }
  return <div className="goal-cards">{goals.value.map(({ intent, metrics }) => <IntentGoalCard key={intent.id} workspaceId={workspace.id} intent={intent} metrics={metrics} />)}</div>;
};

const Products = ({ workspace, myRole, projects }: { workspace: Workspace; myRole: HumanRole; projects: Part<OverviewProject[]> }) => {
  if (!projects.ok) return <ErrorState message={`Projectの読み込みに失敗しました: ${projects.error}`} />;
  const active = projects.value.filter(({ project }) => project.status === "active");
  const archivedCount = projects.value.length - active.length;
  const canCreate = workspace.status === "active" && canOperateWorkspace(myRole, "project.create");
  return (
    <>
      {active.length === 0 ? (
        <p className="unset">{emptyProjectNote(workspace.status, archivedCount, canOperateWorkspace(myRole, "project.create"))}</p>
      ) : (
        <ul className="product-list">
          {active.map(({ project }) => (
            <li key={project.id}>
              <Link to={projectViewPath(project.id, "overview")}>{project.name}</Link>
              {project.description && <p>{project.description}</p>}
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 && <p className="section-note">アーカイブ済みのProjectが{archivedCount}件あります。</p>}
      {canCreate && active.length === 0 && <div className="action-row"><LinkButton size="sm" to={workspaceProjectCreatePath(workspace.id)}>Projectを追加</LinkButton></div>}
    </>
  );
};

/**
 * Workspaceの概要。現状の概要（Agentの説明）→ ビジネス目標（現在値・目標値・7日の推移）→ プロダクト → 対応待ちの順に、実データから出す。
 * 部分ごとに取得失敗・未計測・空を区別し、値の無い目標を達成や0として扱わず、Task・Outcomeの進み具合から目標の到達を示さない。
 */
export const WorkspaceOverview = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [pending, setPending] = useState(false);
  const load = useCallback((isCurrent: () => boolean = () => true) => {
    setPending(true);
    return loadOverview(workspace.id)
      .then((loaded) => { if (isCurrent()) setData(loaded); })
      .finally(() => { if (isCurrent()) setPending(false); });
  }, [workspace.id]);
  useEffect(() => {
    let current = true;
    setData(null);
    void load(() => current);
    return () => { current = false; };
  }, [load]);
  if (!data) return <Loading />;
  const canWrite = workspace.status === "active" && canOperateWorkspace(myRole, "direction.write");
  return (
    <div className="workspace-overview-page">
      <div className="claim-holder-toolbar">
        <span>{formatTime(data.fetchedAt)} 取得</span>
        <Button variant="secondary" size="sm" pending={pending} onClick={() => void load()}>{pending ? "読み込み中..." : "再読込"}</Button>
      </div>
      <section className="detail-section" aria-labelledby="workspace-summary-heading">
        <h2 id="workspace-summary-heading">現状の概要</h2>
        <CurrentSummary workspaceId={workspace.id} goals={data.goals} />
      </section>
      <section className="detail-section" aria-labelledby="workspace-goals-heading">
        <div className="section-heading-row">
          <h2 id="workspace-goals-heading">ビジネス目標</h2>
          {canWrite && <LinkButton variant="secondary" size="sm" to={workspaceIntentCreatePath(workspace.id)}>目標を作成</LinkButton>}
        </div>
        <Goals workspace={workspace} canWrite={canWrite} goals={data.goals} />
      </section>
      <section className="detail-section" aria-labelledby="workspace-products-heading">
        <h2 id="workspace-products-heading">プロダクト</h2>
        <Products workspace={workspace} myRole={myRole} projects={data.projects} />
      </section>
      <section className="detail-section" aria-labelledby="workspace-waiting-heading">
        <h2 id="workspace-waiting-heading" className="visually-hidden">対応待ち</h2>
        <Link className="waiting-bar" to={workspacePath(workspace.id, "consultations")}>
          <span>対応待ち</span>
          <strong>{data.waiting.state === "unknown" ? "件数を取得できません" : `${waitingCountText(data.waiting)}件`}</strong>
        </Link>
        {data.waiting.state === "unknown" && <p className="section-note">件数を取得できませんでした。0件ではありません。</p>}
      </section>
    </div>
  );
};
