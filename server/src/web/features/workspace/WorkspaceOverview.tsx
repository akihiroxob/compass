import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { splitIntents, type Intent } from "../../intentForm";
import { splitOutcomes, type Outcome } from "../../outcomeForm";
import { intentPath, outcomePath, workspaceApiPath } from "../../paths";
import { canOperateWorkspace } from "../../permissions";
import { projectsApiPath } from "../../projectArchive";
import type { Project } from "../../projectForm";
import { statusBadgeClass, type StatusTone } from "../../statusTone";
import { activitiesPath, type ActivityPage, type ActivitySummary } from "../activity";
import { describePrincipal, evaluationsPath, formatTime } from "../execution";
import type { HumanRole } from "../member";
import { projectViewPath } from "../project/overview";
import {
  attentionSummary,
  evaluationStage,
  pickOpenProject,
  planWorkspaceAttention,
  projectTargetNote,
  type AttentionItem,
  type AttentionKind,
  type AttentionRef,
  type Evaluability,
  type EvaluationStage,
  type OutcomeExecution,
  type OutcomePosition,
  type OutcomeTargetWork,
  type TargetWork,
} from "./overview";
import { withProjectAccess, workspacePath, workspaceProjectsPath, type Workspace, type WorkspaceProject } from "./workspace";

/** 概要の各部分の取得結果。部分ごとに失敗を出し、取得失敗を空として表示しない。 */
type Part<T> = { ok: true; value: T } | { ok: false; error: string };

const settle = <T,>(promise: Promise<T>, notFound: string): Promise<Part<T>> =>
  promise.then(
    (value): Part<T> => ({ ok: true, value }),
    (reason: unknown): Part<T> => ({ ok: false, error: loadFailureMessage(classifyError(reason), notFound) }),
  );

type DirectionData = { activeIntent: Intent | null; outcomes: OutcomePosition[] };
type OverviewProject = { project: WorkspaceProject; canOpen: boolean };
type OverviewData = { direction: Part<DirectionData>; projects: Part<OverviewProject[]>; activities: Part<ActivitySummary[]>; fetchedAt: number };

/** 概要に出す最近の記録の件数。続きは「記録」で読む。 */
const recentActivityLimit = 5;

const notFound = "Workspaceが見つからないか、閲覧する権限がありません。";

/** target-executionsの応答のうち概要が使う部分。 */
type TargetExecutions = { targets: { projectId: string; execution: { summary: { executionCursor: number } } | null }[]; evaluability: Evaluability };
/** Evaluationの応答のうち概要が使う部分（新しい順）。 */
type EvaluationRecord = { id: string; snapshot: { targets: { projectId: string; execution: { executionCursor: number } }[] } };

/**
 * Outcomeの還流・評価の状態。評価可能性・現在の還流cursorはtarget-executions、最新Evaluationとその評価snapshotはevaluations、
 * 判断済みかはActive IntentのDirection Decision（`decidedEvaluations`、取得失敗はnull）から読む。どれかを読めなければnull。
 */
const loadExecution = async (workspaceId: string, outcomeId: string, decidedEvaluations: Set<string> | null): Promise<OutcomeExecution | null> => {
  try {
    const [executions, { evaluations }] = await Promise.all([
      request<TargetExecutions>(workspaceApiPath(workspaceId, `/outcomes/${outcomeId}/target-executions`)),
      request<{ evaluations: EvaluationRecord[] }>(evaluationsPath(workspaceId, outcomeId)),
    ]);
    const latest = evaluations[0] ?? null;
    if (latest && !decidedEvaluations) return null;
    return {
      evaluability: executions.evaluability,
      targetCursors: executions.targets.map(({ projectId, execution }) => ({ projectId, executionCursor: execution?.summary.executionCursor ?? null })),
      latestEvaluation: latest && {
        id: latest.id,
        decided: decidedEvaluations!.has(latest.id),
        targetCursors: latest.snapshot.targets.map(({ projectId, execution }) => ({ projectId, executionCursor: execution.executionCursor })),
      },
    };
  } catch {
    return null;
  }
};

/**
 * Active Intent配下のActive Outcomeと、Outcomeごとの Target別Work・還流と評価の状態。Target別Work・Direction DecisionはIntent単位の1回、
 * 還流と評価はOutcomeごとに読み、失敗したものは`null`にして他のOutcomeの表示を妨げない。
 */
const loadDirection = async (workspaceId: string): Promise<DirectionData> => {
  const { active: activeIntent } = splitIntents((await request<{ intents: Intent[] }>(workspaceApiPath(workspaceId, "/intents"))).intents);
  if (!activeIntent) return { activeIntent, outcomes: [] };
  const [{ outcomes }, targetWork, decidedEvaluations] = await Promise.all([
    request<{ outcomes: Outcome[] }>(workspaceApiPath(workspaceId, `/intents/${activeIntent.id}/outcomes`)),
    request<{ outcomes: OutcomeTargetWork[] }>(workspaceApiPath(workspaceId, `/intents/${activeIntent.id}/outcome-target-work`)).then(
      (body) => new Map(body.outcomes.map((item) => [item.outcomeId, item.targets])),
      () => null,
    ),
    request<{ decisions: { evaluationId: string | null }[] }>(workspaceApiPath(workspaceId, `/intents/${activeIntent.id}/decisions`)).then(
      (body) => new Set(body.decisions.flatMap(({ evaluationId }) => (evaluationId ? [evaluationId] : []))),
      () => null,
    ),
  ]);
  const positions = splitOutcomes(outcomes).active.map(async (outcome): Promise<OutcomePosition> => ({
    outcome: { id: outcome.id, intentId: outcome.intentId, title: outcome.title },
    targets: targetWork?.get(outcome.id) ?? null,
    execution: await loadExecution(workspaceId, outcome.id, decidedEvaluations),
  }));
  return { activeIntent, outcomes: await Promise.all(positions) };
};

/** 所属Project（active・archived）と、HumanがProject Membershipで開けるか。archivedのTargetも名前を引けるようにする。 */
const loadProjects = (workspaceId: string): Promise<OverviewProject[]> =>
  Promise.all(
    (["active", "archived"] as const).map((status) =>
      Promise.all([
        request<{ projects: WorkspaceProject[] }>(workspaceApiPath(workspaceId, `/projects${status === "archived" ? "?status=archived" : ""}`)),
        request<{ projects: Project[] }>(projectsApiPath(status)),
      ]).then(([workspace, member]) => withProjectAccess(workspace.projects, new Set(member.projects.map(({ id }) => id)))),
    ),
  ).then((lists) => lists.flat());

const loadOverview = async (workspaceId: string): Promise<OverviewData> => {
  const [direction, projects, activities] = await Promise.all([
    settle(loadDirection(workspaceId), notFound),
    settle(loadProjects(workspaceId), notFound),
    settle(request<ActivityPage>(activitiesPath({ kind: "workspace", workspaceId }, null, recentActivityLimit)).then((page) => page.activities), notFound),
  ]);
  return { direction, projects, activities, fetchedAt: Date.now() };
};

const stageLabels: Record<EvaluationStage, { label: string; tone: StatusTone }> = {
  decided: { label: "判断済み", tone: "done" },
  decision_pending: { label: "評価済み・判断待ち", tone: "attention" },
  evaluation_pending: { label: "評価待ち", tone: "waiting" },
  no_targets: { label: "Target未設定", tone: "attention" },
  replan_required: { label: "再計画待ち", tone: "warning" },
  awaiting_execution: { label: "実行・還流待ち", tone: "progress" },
};

const attentionLabels: Record<AttentionKind, { label: string; tone: StatusTone }> = {
  intent: { label: "Intent未登録", tone: "attention" },
  outcome: { label: "Outcome未登録", tone: "attention" },
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

const workCountLabels = { todo: "未着手", doing: "作業中", in_review: "レビュー待ち", wait_accept: "受入待ち", rejected: "差戻し", accepted: "受入済み" } as const;

/** Project名とリンク。Project Membershipが無ければリンクにせず理由を出す。一覧を取得できなければIDだけを出す。 */
const ProjectName = ({ projectId, projects, view }: { projectId: string; projects: Part<OverviewProject[]>; view: "overview" | "work" }) => {
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

/** Outcome名。詳細画面はProject配下のため、開けるProject（Targetを優先）が無ければリンクにしない。 */
const OutcomeName = ({ outcome, openProjectId }: { outcome: OutcomePosition["outcome"]; openProjectId: string | null }) =>
  openProjectId ? <Link to={outcomePath(openProjectId, outcome.intentId, outcome.id)}>{outcome.title}</Link> : <span>{outcome.title}</span>;

const openProjects = (projects: Part<OverviewProject[]>) =>
  projects.ok ? projects.value.map(({ project, canOpen }) => ({ id: project.id, status: project.status, canOpen })) : [];

const TargetRow = ({ target, projects }: { target: TargetWork; projects: Part<OverviewProject[]> }) => {
  const counts = target.work ? (Object.keys(workCountLabels) as (keyof typeof workCountLabels)[]).filter((key) => target.work!.taskCounts[key] > 0) : [];
  return (
    <li>
      <ProjectName projectId={target.projectId} projects={projects} view="work" />
      <small>
        {target.work === null
          ? "Storyはまだありません"
          : counts.length === 0 && target.work.taskCounts.canceled === 0
          ? <>Story {target.work.storyCount}件 ・ Taskはまだありません</>
          : <>Story {target.work.storyCount}件{counts.map((key) => <span key={key}> ・ {workCountLabels[key]} {target.work!.taskCounts[key]}</span>)}</>}
      </small>
    </li>
  );
};

/** 現在地: Active Intent → Active Outcome → Target Project別のWork → 評価可能性。Taskの受入をOutcomeの達成として出さない。 */
const CurrentPosition = ({ direction, projects }: { direction: DirectionData; projects: Part<OverviewProject[]> }) => {
  const intentProject = pickOpenProject([], openProjects(projects));
  if (!direction.activeIntent) return <p className="unset">ActiveなIntentはありません。</p>;
  return (
    <>
      <p className="section-label">Active Intent</p>
      <p className="workspace-intent">{intentProject ? <Link to={intentPath(intentProject, direction.activeIntent.id)}>{direction.activeIntent.title}</Link> : direction.activeIntent.title}</p>
      <p className="section-label">Active Outcome（{direction.outcomes.length}件）</p>
      {direction.outcomes.length === 0 ? <p className="unset">ActiveなOutcomeはありません。</p> : (
        <ul className="workspace-outcomes">
          {direction.outcomes.map((position) => {
            const stage = position.execution ? stageLabels[evaluationStage(position.execution)] : null;
            return (
              <li key={position.outcome.id}>
                <div className="workspace-outcome-head">
                  <OutcomeName outcome={position.outcome} openProjectId={pickOpenProject(position.targets?.map(({ projectId }) => projectId) ?? [], openProjects(projects))} />
                  {stage ? <span className={statusBadgeClass(stage.tone)}>{stage.label}</span> : <span className="status-badge muted">還流・評価の状態を確認できません</span>}
                </div>
                <p className="section-label">Target Project</p>
                {position.targets === null ? <p role="alert" className="error-title">Target Projectを確認できません。</p> : position.targets.length === 0 ? <p className="unset">Target Projectはまだありません。</p> : (
                  <ul className="workspace-targets">{position.targets.map((target) => <TargetRow key={target.projectId} target={target} projects={projects} />)}</ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

const AttentionRefItem = ({ refItem, kind, projects }: { refItem: AttentionRef; kind: AttentionKind; projects: Part<OverviewProject[]> }) => (
  <span className="attention-ref">
    <OutcomeName outcome={refItem.outcome} openProjectId={pickOpenProject(refItem.projectId ? [refItem.projectId] : [], openProjects(projects))} />
    {refItem.projectId && <> / <ProjectName projectId={refItem.projectId} projects={projects} view={kind === "story" || kind === "decompose" || kind === "replan" ? "overview" : "work"} /></>}
    {refItem.count !== null && <> {refItem.count}件</>}
  </span>
);

/** Humanの登録（Intent・Outcome）の導線。作成画面はProject配下のため、開けるProjectが無ければ理由を出す。 */
const HumanAction = ({ item, intentId, projectId, canWrite }: { item: AttentionItem; intentId: string | null; projectId: string | null; canWrite: boolean }) => {
  if (!canWrite) return <small>Workspace Editor以上へ依頼</small>;
  if (!projectId) return <small>登録画面を開けるProjectがありません（Project Membershipが必要です）</small>;
  const to = item.kind === "intent" ? intentPath(projectId, "new") : intentId ? outcomePath(projectId, intentId, "new") : null;
  return to ? <Link to={to} className="button compact">{item.kind === "intent" ? "Intentを登録" : "Outcomeを登録"}</Link> : null;
};

const Attention = ({ workspace, myRole, direction, projects }: { workspace: Workspace; myRole: HumanRole; direction: DirectionData; projects: Part<OverviewProject[]> }) => {
  if (workspace.status === "archived") return <p className="unset">アーカイブ済みのため、要対応はありません。</p>;
  const attention = planWorkspaceAttention({ activeIntent: direction.activeIntent !== null, outcomes: direction.outcomes });
  const summary = attentionSummary(attention);
  const canWrite = canOperateWorkspace(myRole, "direction.write");
  const project = pickOpenProject([], openProjects(projects));
  return (
    <>
      {summary && <p className="next-action-summary">{summary}</p>}
      {attention.items.length > 0 && (
        <ul className="next-action-list waiting">
          {attention.items.map((item) => {
            const total = item.refs.reduce((sum, refItem) => sum + (refItem.count ?? 1), 0);
            return (
              <li key={item.kind}>
                <span><span className={statusBadgeClass(attentionLabels[item.kind].tone)}>{attentionLabels[item.kind].label}</span>{item.refs.length > 0 && <> {total}件</>} — {item.note}</span>
                {item.actor === "human" && <HumanAction item={item} intentId={direction.activeIntent?.id ?? null} projectId={project} canWrite={canWrite} />}
                {item.refs.length > 0 && <small className="attention-refs">{item.refs.map((refItem, index) => <span key={`${refItem.outcome.id}-${refItem.projectId ?? ""}`}>{index > 0 && "、"}<AttentionRefItem refItem={refItem} kind={item.kind} projects={projects} /></span>)}</small>}
              </li>
            );
          })}
        </ul>
      )}
      {attention.outcomeFailures > 0 && <p role="alert" className="error-title">一部のOutcome（{attention.outcomeFailures}件）のTarget Project・還流・評価の状態を確認できません。再読込してください。</p>}
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
        <ul className="link-list workspace-agent-projects">
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
      <ul className="workspace-activities">
        {activities.value.map((activity) => <li key={activity.id}>{activity.summary}<small>{describePrincipal(activity.principalId)}（{activity.role}） ・ {formatTime(activity.occurredAt)}</small></li>)}
      </ul>
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
        {data.direction.ok ? <CurrentPosition direction={data.direction.value} projects={data.projects} /> : <ErrorState message={`Intent・Outcomeの読み込みに失敗しました: ${data.direction.error}`} />}
        {outcomes && outcomes.length > 0 && <p className="section-note">Taskの件数は状態だけを数えたもので、Agentの稼働やClaimの有効性を示しません。Claimの状況は各Projectの概要で確認します。</p>}
        <Link to={workspacePath(workspace.id, "direction")} className="text-link">方向を開く →</Link>
      </section>
      <section className="detail-section" aria-labelledby="workspace-attention-heading">
        <h2 id="workspace-attention-heading">要対応</h2>
        {data.direction.ok ? <Attention workspace={workspace} myRole={myRole} direction={data.direction.value} projects={data.projects} /> : <p role="alert" className="error-title">Intent・Outcomeを確認できないため、要対応を判定できません。</p>}
      </section>
      <section className="detail-section" aria-labelledby="workspace-projects-heading">
        <h2 id="workspace-projects-heading">Project</h2>
        <ProjectSummary workspace={workspace} projects={data.projects} outcomes={outcomes} />
      </section>
      <section className="detail-section" aria-labelledby="workspace-overview-agents-heading">
        <h2 id="workspace-overview-agents-heading">Agent</h2>
        <p className="section-note">Agentの稼働状況は、この画面では判断しません。Role割当・Credential・Claimは稼働を示さないため、担当待ちは「要対応」に、Agentの割当は各Projectの設定に出します。</p>
        <Link to={workspacePath(workspace.id, "agents")} className="text-link">Agentを開く →</Link>
      </section>
      <section className="detail-section" aria-labelledby="workspace-recent-heading">
        <h2 id="workspace-recent-heading">最近の記録</h2>
        <RecentActivity workspace={workspace} activities={data.activities} />
      </section>
    </>
  );
};
