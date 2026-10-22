import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { request, settle, type Part } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentPath, outcomePath, projectViewPath, researchRequestPath, workspaceOutcomePath, workspacePath, workspaceProjectsPath } from "../../paths";
import { statusBadgeClass, type StatusTone } from "../../statusTone";
import { canOperateWorkspace } from "../access";
import { activitiesPath, RecentActivityList, type ActivityPage, type ActivitySummary } from "../activity";
import {
  attentionSummary,
  evaluationStage,
  loadDirection,
  loadOpenResearch,
  noTargetNote,
  pickOpenProject,
  planWorkspaceAttention,
  projectTargetNote,
  stageLabels,
  WorkCounts,
  type AttentionItem,
  type AttentionKind,
  type AttentionRef,
  type DirectionData,
  type OutcomePosition,
  type OverviewResearch,
  type TargetWork,
} from "../direction";
import { formatTime } from "../execution";
import type { HumanRole } from "../member";
import type { Workspace } from "./workspace";
import { loadProjects, type OverviewProject } from "./workspaceProjects";

type OverviewData = {
  direction: Part<DirectionData>;
  /** Workspaceの未終了のResearch Request。要対応の判定にだけ使う。 */
  research: Part<OverviewResearch[]>;
  projects: Part<OverviewProject[]>;
  activities: Part<ActivitySummary[]>;
  fetchedAt: number;
};

/** 概要に出す最近の記録の件数。続きは「記録」で読む。 */
const recentActivityLimit = 5;

const notFound = "Workspaceが見つからないか、閲覧する権限がありません。";

const loadOverview = async (workspaceId: string): Promise<OverviewData> => {
  const [direction, research, projects, activities] = await Promise.all([
    settle(loadDirection(workspaceId), notFound),
    settle(loadOpenResearch(workspaceId), notFound),
    settle(loadProjects(workspaceId), notFound),
    settle(request<ActivityPage>(activitiesPath({ kind: "workspace", workspaceId }, { limit: recentActivityLimit })).then((page) => page.activities), notFound),
  ]);
  return { direction, research, projects, activities, fetchedAt: Date.now() };
};

const attentionLabels: Record<AttentionKind, { label: string; tone: StatusTone }> = {
  intent: { label: "Intent未登録", tone: "attention" },
  next_direction: { label: "次の判断待ち", tone: "attention" },
  outcome: { label: "Outcome未登録", tone: "attention" },
  research: { label: "調査待ち", tone: "progress" },
  no_targets: { label: "Target未設定", tone: "attention" },
  replan: { label: "再計画待ち", tone: "warning" },
  decision: { label: "判断待ち", tone: "attention" },
  story: { label: "Story起票待ち", tone: "waiting" },
  decompose: { label: "Task分解待ち", tone: "waiting" },
  todo: { label: "未着手", tone: "waiting" },
  rejected: { label: "差戻し", tone: "attention" },
  in_review: { label: "レビュー待ち", tone: "progress" },
  wait_accept: { label: "受入待ち", tone: "attention" },
  reflection: { label: "還流待ち", tone: "waiting" },
  evaluation: { label: "評価待ち", tone: "waiting" },
};

/** Project名とリンク。Project Membershipが無ければリンクにせず理由を出す。一覧を取得できなければIDだけを出す。 */
export const ProjectName = ({ projectId, projects, view }: { projectId: string; projects: Part<OverviewProject[]>; view: "overview" | "work" }) => {
  const found = projects.ok ? projects.value.find(({ project }) => project.id === projectId) : undefined;
  if (!found) return <code>{projectId.slice(0, 8)}</code>;
  return (
    <>
      {found.canOpen ? <Link to={projectViewPath(projectId, view)}>{found.project.name}</Link> : <span>{found.project.name}</span>}
      {found.project.status === "archived" && <> <span className="status-badge muted">アーカイブ済み</span></>}
      {!found.canOpen && <small className="locked-note">（Project Membershipが無いため開けません）</small>}
    </>
  );
};

/** Outcome名。WorkspaceのOutcome詳細（Workspace Membershipで閲覧）へ辿る。 */
const OutcomeName = ({ workspaceId, outcome }: { workspaceId: string; outcome: OutcomePosition["outcome"] }) =>
  <Link to={workspaceOutcomePath(workspaceId, outcome.intentId, outcome.id)}>{outcome.title}</Link>;

export const openProjects = (projects: Part<OverviewProject[]>) =>
  projects.ok ? projects.value.map(({ project, canOpen }) => ({ id: project.id, status: project.status, canOpen })) : [];

export const TargetRow = ({ target, projects }: { target: TargetWork; projects: Part<OverviewProject[]> }) => (
  <li>
    <ProjectName projectId={target.projectId} projects={projects} view="work" />
    <WorkCounts work={target.work} />
  </li>
);

/** 現在地: Active Intent → Active Outcome → Target Project別のWork → 評価可能性。Taskの受入をOutcomeの達成として出さない。 */
const CurrentPosition = ({ workspaceId, direction, projects }: { workspaceId: string; direction: DirectionData; projects: Part<OverviewProject[]> }) => {
  const intentProject = pickOpenProject([], openProjects(projects));
  if (!direction.activeIntent) return <p className="unset">ActiveなIntentはありません。</p>;
  return (
    <>
      <p className="section-label">Active Intent</p>
      <p className="workspace-intent">{intentProject ? <Link to={intentPath(intentProject, direction.activeIntent.id)}>{direction.activeIntent.title}</Link> : direction.activeIntent.title}</p>
      <p className="section-label">Active Outcome（{direction.outcomes.length}件）</p>
      {direction.outcomes.length === 0 ? <p className="unset">ActiveなOutcomeはありません。</p> : (
        <ul className="outcome-positions">
          {direction.outcomes.map((position) => {
            const stage = position.execution ? stageLabels[evaluationStage(position.execution)] : null;
            return (
              <li key={position.outcome.id}>
                <div className="outcome-position-head">
                  <OutcomeName workspaceId={workspaceId} outcome={position.outcome} />
                  {stage ? <span className={statusBadgeClass(stage.tone)}>{stage.label}</span> : <span className="status-badge muted">還流・評価の状態を確認できません</span>}
                </div>
                <p className="section-label">Target Project</p>
                {position.targets === null ? <p role="alert" className="error-title">Target Projectを確認できません。</p> : position.targets.length === 0 ? <p className="unset">{noTargetNote("active")}</p> : (
                  <ul className="target-works">{position.targets.map((target) => <TargetRow key={target.projectId} target={target} projects={projects} />)}</ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

/** 要対応の根拠。OutcomeはWorkspaceのOutcome詳細、Intent・Research RequestはProject配下の詳細を開けるProject（`openProject`）から辿る。 */
const AttentionRefItem = ({ workspaceId, refItem, kind, projects, openProject }: { workspaceId: string; refItem: AttentionRef; kind: AttentionKind; projects: Part<OverviewProject[]>; openProject: string | null }) => {
  if (refItem.on === "intent") return <span className="attention-ref">{openProject ? <Link to={intentPath(openProject, refItem.intent.id)}>{refItem.intent.title}</Link> : refItem.intent.title}</span>;
  if (refItem.on === "research") return <span className="attention-ref">{openProject ? <Link to={researchRequestPath(openProject, refItem.request.id)}>{refItem.request.question}</Link> : refItem.request.question}</span>;
  return (
    <span className="attention-ref">
      <OutcomeName workspaceId={workspaceId} outcome={refItem.outcome} />
      {refItem.projectId && <> / <ProjectName projectId={refItem.projectId} projects={projects} view={kind === "story" || kind === "decompose" || kind === "replan" ? "overview" : "work"} /></>}
      {refItem.count !== null && <> {refItem.count}件</>}
    </span>
  );
};

/** 根拠のReact key。 */
const refKey = (refItem: AttentionRef) =>
  refItem.on === "outcome" ? `${refItem.outcome.id}-${refItem.projectId ?? ""}` : refItem.on === "intent" ? `intent-${refItem.intent.id}` : `research-${refItem.request.id}`;

/** Humanの登録（Intent・Outcome）の導線。作成画面はProject配下のため、開けるProjectが無ければ理由を出す。 */
const HumanAction = ({ item, intentId, projectId, canWrite }: { item: AttentionItem; intentId: string | null; projectId: string | null; canWrite: boolean }) => {
  if (!canWrite) return <small>Workspace Editor以上へ依頼</small>;
  if (!projectId) return <small>登録画面を開けるProjectがありません（Project Membershipが必要です）</small>;
  const to = item.kind === "intent" ? intentPath(projectId, "new") : intentId ? outcomePath(projectId, intentId, "new") : null;
  return to ? <Link to={to} className="button compact">{item.kind === "intent" ? "Intentを登録" : "Outcomeを登録"}</Link> : null;
};

const Attention = ({ workspace, myRole, direction, research, projects }: { workspace: Workspace; myRole: HumanRole; direction: DirectionData; research: Part<OverviewResearch[]>; projects: Part<OverviewProject[]> }) => {
  if (workspace.status === "archived") return <p className="unset">アーカイブ済みのため、要対応はありません。</p>;
  const attention = planWorkspaceAttention({
    activeIntent: direction.activeIntent && { id: direction.activeIntent.id, title: direction.activeIntent.title },
    outcomes: direction.outcomes,
    pendingPastOutcomes: direction.pendingPastOutcomes,
    research: research.ok ? research.value : null,
  });
  const summary = attentionSummary(attention);
  const canWrite = canOperateWorkspace(myRole, "direction.write");
  const project = pickOpenProject([], openProjects(projects));
  return (
    <>
      {summary && <p className="next-action-summary">{summary}</p>}
      {attention.items.length > 0 && (
        <ul className="next-action-list waiting">
          {attention.items.map((item) => {
            const total = item.refs.reduce((sum, refItem) => sum + (refItem.on === "outcome" ? refItem.count ?? 1 : 1), 0);
            return (
              <li key={item.kind}>
                <span><span className={statusBadgeClass(attentionLabels[item.kind].tone)}>{attentionLabels[item.kind].label}</span>{item.refs.length > 0 && <> {total}件</>} — {item.note}</span>
                {item.actor === "human" && <HumanAction item={item} intentId={direction.activeIntent?.id ?? null} projectId={project} canWrite={canWrite} />}
                {item.refs.length > 0 && <small className="attention-refs">{item.refs.map((refItem, index) => <span key={refKey(refItem)}>{index > 0 && "、"}<AttentionRefItem workspaceId={workspace.id} refItem={refItem} kind={item.kind} projects={projects} openProject={project} /></span>)}</small>}
              </li>
            );
          })}
        </ul>
      )}
      {attention.outcomeFailures > 0 && <p role="alert" className="error-title">一部のOutcome（{attention.outcomeFailures}件）のTarget Project・還流・評価の状態を確認できません。再読込してください。</p>}
      {attention.unconfirmed.map((note) => <p key={note} role="alert" className="error-title">{note}。再読込してください。</p>)}
    </>
  );
};

/** `outcomes`はActive Outcomeの現在地。Intent・Outcomeを取得できなければnullで、Targetかどうかを断定しない。 */
const ProjectSummary = ({ workspace, projects, outcomes }: { workspace: Workspace; projects: Part<OverviewProject[]>; outcomes: readonly OutcomePosition[] | null }) => {
  if (!projects.ok) return <ErrorState message={`Projectの読み込みに失敗しました: ${projects.error}`} />;
  const active = projects.value.filter(({ project }) => project.status === "active");
  const archivedCount = projects.value.length - active.length;
  return (
    <>
      {active.length === 0 ? <p className="unset">activeなProjectはありません。</p> : (
        <ul className="link-list workspace-project-links">
          {active.map(({ project, canOpen }) => {
            const note = projectTargetNote(outcomes, project.id);
            return <li key={project.id}>{canOpen ? <Link to={projectViewPath(project.id, "overview")}><span>{project.name}</span><small>{note}</small></Link> : <p><span>{project.name}</span><small>{note} ・ Project Membershipが無いため開けません</small></p>}</li>;
          })}
        </ul>
      )}
      {archivedCount > 0 && <p className="section-note">アーカイブ済みのProjectが{archivedCount}件あります。</p>}
      <Link to={workspaceProjectsPath(workspace.id)} className="text-link">Projectを開く →</Link>
    </>
  );
};

const RecentActivity = ({ workspace, activities }: { workspace: Workspace; activities: Part<ActivitySummary[]> }) => (
  <>
    {!activities.ok ? <ErrorState message={`記録の読み込みに失敗しました: ${activities.error}`} /> : activities.value.length === 0 ? <p className="unset">Workspaceの記録はまだありません。</p> : (
      <RecentActivityList activities={activities.value} />
    )}
    <Link to={workspacePath(workspace.id, "activity")} className="text-link">記録を開く →</Link>
  </>
);

/**
 * Workspaceの概要（S10-01）。現在地（どのOutcomeをどのProjectが担当し、どこまで進んだか）・要対応・Project・Agent・最近の記録を
 * 実データから出す。部分ごとに取得失敗・空・archivedを区別し、Role割当やClaimからAgentが稼働中であるとは表示しない。
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
  const outcomes = data.direction.ok ? data.direction.value.outcomes : null;
  return (
    <>
      <section className="detail-section workspace-overview" aria-labelledby="workspace-position-heading">
        <h2 id="workspace-position-heading">現在地</h2>
        <div className="claim-holder-toolbar">
          <span>{formatTime(data.fetchedAt)} 取得</span>
          <button type="button" className="secondary-button compact" disabled={pending} onClick={() => void load()}>{pending ? "読み込み中..." : "再読込"}</button>
        </div>
        {data.direction.ok ? <CurrentPosition workspaceId={workspace.id} direction={data.direction.value} projects={data.projects} /> : <ErrorState message={`Intent・Outcomeの読み込みに失敗しました: ${data.direction.error}`} />}
        {outcomes && outcomes.length > 0 && <p className="section-note">Taskの件数は状態だけを数えたもので、Agentの稼働やClaimの有効性を示しません。Claimの状況は各Projectの概要で確認します。</p>}
        <Link to={workspacePath(workspace.id, "direction")} className="text-link">方向を開く →</Link>
      </section>
      <section className="detail-section" aria-labelledby="workspace-attention-heading">
        <h2 id="workspace-attention-heading">要対応</h2>
        {data.direction.ok ? <Attention workspace={workspace} myRole={myRole} direction={data.direction.value} research={data.research} projects={data.projects} /> : <p role="alert" className="error-title">Intent・Outcomeを確認できないため、要対応を判定できません。</p>}
      </section>
      <section className="detail-section" aria-labelledby="workspace-projects-heading">
        <h2 id="workspace-projects-heading">Project</h2>
        <ProjectSummary workspace={workspace} projects={data.projects} outcomes={outcomes} />
      </section>
      <section className="detail-section" aria-labelledby="workspace-overview-agents-heading">
        <h2 id="workspace-overview-agents-heading">Agent</h2>
        <p className="section-note">Agentの稼働状況は、この画面では判断しません。Role割当・Credential・Claimは稼働を示さないため、担当待ちは「要対応」に、Role割当・Credential・保持中のClaimはAgent画面に出します。</p>
        <Link to={workspacePath(workspace.id, "agents")} className="text-link">Agentを開く →</Link>
      </section>
      <section className="detail-section" aria-labelledby="workspace-recent-heading">
        <h2 id="workspace-recent-heading">最近の記録</h2>
        <RecentActivity workspace={workspace} activities={data.activities} />
      </section>
    </>
  );
};
