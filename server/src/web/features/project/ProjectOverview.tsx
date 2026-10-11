import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import type { Project } from "../../projectForm";
import { statusBadgeClass, type StatusTone } from "../../statusTone";
import { activitiesPath, RecentActivityList, type ActivityPage, type ActivitySummary } from "../activity";
import { credentialSectionId, credentialStatus, credentialsPath, type Credential } from "../credential";
import {
  ClaimHolderSection,
  executionPath,
  formatTime,
  storyAnchorId,
  storyStatusLabels,
  storyStatusTones,
  taskAnchorId,
  taskStatusLabels,
  taskStatusTones,
  type ExecutionOverview,
  type ExecutionStory,
} from "../execution";
import { agentRoleAnchorId, grantRoleLabels, grantsPath, type Grant } from "../grant";
import { loadDirection, settle, type DirectionData, type Part } from "../workspace/directionData";
import { stageLabels, WorkCounts } from "../workspace/WorkspaceOverview";
import { workspaceOutcomePath, workspacePath } from "../workspace/workspace";
import {
  agentsWithoutCredential,
  contributionStage,
  countWork,
  nextClaimExpiry,
  nextActionSummary,
  planNextActions,
  projectContributionNote,
  projectContributions,
  projectViewPath,
  type MyAction,
  type OverviewPermissions,
  type ProjectContribution,
  type WaitingItem,
  type WaitingKind,
  type WorkBucket,
} from "./overview";

const workBucketLabels: Record<WorkBucket, string> = { ...taskStatusLabels, reclaimable: "再取得待ち" };
const waitingLabels: Record<WaitingKind, string> = { ...workBucketLabels, story: "Story起票待ち", decompose: "Task分解待ち", reflection: "還流待ち" };
const workBucketTones: Record<WorkBucket, StatusTone> = { ...taskStatusTones, reclaimable: "warning" };
const waitingTones: Record<WaitingKind, StatusTone> = { ...workBucketTones, story: "waiting", decompose: "waiting", reflection: "waiting" };

/** 実行状況に並べる未完了Storyの上限と、最近の記録の件数。続きは「実行」「記録」で読む。 */
const storyDisplayLimit = 5;
const recentActivityLimit = 5;

const notFound = "Projectが見つからないか、閲覧する権限がありません。";

/**
 * 所属WorkspaceのDirectionの閲覧。`workspaceId`はWorkspace Membershipで閲覧できる場合だけ持ち、閲覧できない・取得に失敗した場合は理由を持つ。
 * DirectionはProject Membershipから継承しない。
 */
export type OverviewDirectionAccess = { workspaceId: string } | { workspaceId: null; message: string };

/** 部分ごとの取得結果。`direction`はWorkspaceのDirectionを閲覧できなければnull、`credentials`はadministrator以外ではnull。 */
type OverviewData = {
  execution: Part<ExecutionOverview>;
  grants: Part<Grant[]>;
  credentials: Part<Credential[]> | null;
  direction: Part<DirectionData> | null;
  activities: Part<ActivitySummary[]>;
  fetchedAt: number;
};

const loadOverview = async (projectId: string, workspaceId: string | null, showCredentials: boolean): Promise<OverviewData> => {
  const [execution, grants, credentials, direction, activities] = await Promise.all([
    settle(request<ExecutionOverview>(executionPath(projectId)), notFound),
    settle(request<{ grants: Grant[] }>(grantsPath(projectId)).then((body) => body.grants), notFound),
    showCredentials ? settle(request<{ credentials: Credential[] }>(credentialsPath(projectId)).then((body) => body.credentials), notFound) : null,
    workspaceId === null ? null : settle(loadDirection(workspaceId), "所属Workspaceが見つからないか、閲覧する権限がありません。"),
    settle(request<ActivityPage>(activitiesPath({ kind: "project", projectId }, { limit: recentActivityLimit })).then((page) => page.activities), notFound),
  ]);
  return { execution, grants, credentials, direction, activities, fetchedAt: Date.now() };
};

/** RepositoryとResourceのリンク。成果物の正本は外部にあり、Compassは参照だけを持つ。 */
export const ResourceLinks = ({ values }: { values: readonly { id: string; name: string; url: string; kind?: string | null }[] }) => (
  <div className="link-list">{values.map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={item.id}><span>{item.name}</span><small>{item.kind || item.url}</small></a>)}</div>
);

/** Purpose・Resourceと所属Workspaceへの導線。Mission等の戦略値はWorkspaceが持ち、Projectには複製しない。 */
const ExecutionBoundary = ({ project, direction }: { project: Project; direction: OverviewDirectionAccess }) => {
  const resources = [...project.repositories.map((item) => ({ ...item, kind: "Repository" })), ...project.resources];
  return (
    <section className="detail-section" aria-labelledby="boundary-heading">
      <h2 id="boundary-heading">実行境界</h2>
      <p className="section-note">Mission・Vision・Principles・Constraintsと、Intent・Outcomeは所属Workspaceのもので、Projectは実行（Story・Task）とResourceを持ちます。</p>
      <dl className="intent-facts">
        <dt>Purpose</dt>
        <dd>{project.description ?? <span className="unset">未設定（「設定」のProjectの編集で登録します）</span>}</dd>
        <dt>Resource</dt>
        <dd>{resources.length ? <ResourceLinks values={resources} /> : <span className="unset">RepositoryとResourceは未設定です。</span>}</dd>
      </dl>
      {direction.workspaceId !== null && <Link to={workspacePath(direction.workspaceId, "direction")} className="text-link">所属Workspaceの方向へ →</Link>}
    </section>
  );
};

/** 貢献Outcome 1件。このProjectのWorkとStoryだけを出し、ほかのTarget ProjectはWorkspaceのOutcome詳細で見る。 */
const ContributionItem = ({ projectId, workspaceId, contribution, stories }: { projectId: string; workspaceId: string; contribution: ProjectContribution; stories: readonly ExecutionStory[] | null }) => {
  const { outcome, target, otherTargets } = contribution;
  const stage = contributionStage(contribution);
  const label = stage ? stageLabels[stage] : null;
  return (
    <li>
      <div className="outcome-position-head">
        <Link to={workspaceOutcomePath(workspaceId, outcome.intentId, outcome.id)}>{outcome.title}</Link>
        {label ? <span className={statusBadgeClass(label.tone)}>{label.label}</span> : <span className="status-badge muted">還流・評価の状態を確認できません</span>}
      </div>
      <p className="section-label">このProjectのWork</p>
      <ul className="target-works">
        <li>
          {projectContributionNote(contribution)}
          {target.work !== null && <WorkCounts work={target.work} />}
        </li>
      </ul>
      {stories === null ? <p role="alert" className="error-title">Storyを確認できません。</p> : stories.length > 0 && (
        <ul className="outcome-list">
          {stories.map((story) => (
            <li key={story.id}>
              <Link to={projectViewPath(projectId, "work", storyAnchorId(story.id))}>
                <span className={statusBadgeClass(storyStatusTones[story.status])}>{storyStatusLabels[story.status]}</span> {story.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {otherTargets > 0 && <p className="section-note">ほかにTarget Projectが{otherTargets}件あり、Outcomeの詳細でProjectごとの貢献を確認できます。</p>}
    </li>
  );
};

/** 貢献Outcome。Active OutcomeのうちこのProjectがTargetのもの。取得失敗・閲覧不可・Targetではない・確認できないを区別する。 */
const Contributions = ({ projectId, direction, data }: { projectId: string; direction: OverviewDirectionAccess; data: OverviewData }) => {
  if (direction.workspaceId === null || data.direction === null) return <p className="unset">所属WorkspaceのDirectionを閲覧できないため、貢献するOutcomeを表示できません。{"message" in direction && <> {direction.message}</>}</p>;
  if (!data.direction.ok) return <ErrorState message={`Intent・Outcomeの読み込みに失敗しました: ${data.direction.error}`} />;
  if (!data.direction.value.activeIntent) return <p className="unset">所属WorkspaceにActiveなIntentがありません。IntentはWorkspaceの方向でHumanが登録します。</p>;
  const { items, unknown } = projectContributions(data.direction.value.outcomes, projectId);
  const stories = data.execution.ok ? data.execution.value.stories : null;
  return (
    <>
      {items.length === 0 ? (
        <p className="unset">
          {unknown.length
            ? `貢献するOutcomeか確認できません（Outcome ${unknown.length}件のTarget Projectを取得できません）。`
            : "このProjectは、ActiveなOutcomeのTarget Projectではありません。担当するProjectはWorkspaceのStrategistが判断します。"}
        </p>
      ) : (
        <ul className="outcome-positions">
          {items.map((item) => <ContributionItem key={item.outcome.id} projectId={projectId} workspaceId={direction.workspaceId} contribution={item} stories={stories && stories.filter((story) => story.outcomeId === item.outcome.id)} />)}
        </ul>
      )}
      {items.length > 0 && unknown.length > 0 && <p role="alert" className="error-title">ほかにOutcome {unknown.length}件のTarget Projectを確認できません。再読込してください。</p>}
    </>
  );
};

/** 実行状況: Taskの区分ごとの件数と、未完了のStory。Taskの状態だけを数え、Agentの稼働を示さない。 */
const WorkProgress = ({ projectId, execution, now }: { projectId: string; execution: Part<ExecutionOverview>; now: number }) => {
  if (!execution.ok) return <ErrorState message={`Story・Taskの読み込みに失敗しました: ${execution.error}`} />;
  const { stories, tasks } = execution.value;
  const work = countWork(tasks, now);
  const accepted = tasks.filter((task) => task.status === "accepted").length;
  const open = stories.filter((story) => story.status === "todo" || story.status === "doing");
  const settled = stories.length - open.length;
  return (
    <>
      {work.length || accepted ? (
        <p className="position-work">
          {work.map(({ bucket, count }) => <span key={bucket}><span className={statusBadgeClass(workBucketTones[bucket])}>{workBucketLabels[bucket]}</span> {count}件</span>)}
          {accepted > 0 && <span><span className={statusBadgeClass(taskStatusTones.accepted)}>{taskStatusLabels.accepted}</span> {accepted}件</span>}
        </p>
      ) : <p className="unset">{stories.length ? "Taskはまだありません。" : "StoryとTaskはまだありません。StoryはOutcomeのTargetになったProjectのManagerが起票します。"}</p>}
      {open.length > 0 && (
        <>
          <p className="section-label">未完了のStory（{open.length}件）</p>
          <ul className="outcome-list">
            {open.slice(0, storyDisplayLimit).map((story) => {
              const counts = countWork(tasks.filter((task) => task.storyId === story.id), now);
              return (
                <li key={story.id}>
                  <Link to={projectViewPath(projectId, "work", storyAnchorId(story.id))}>
                    <span className={statusBadgeClass(storyStatusTones[story.status])}>{storyStatusLabels[story.status]}</span> {story.title}
                    <small>{counts.length ? counts.map(({ bucket, count }) => `${workBucketLabels[bucket]} ${count}`).join(" ・ ") : "未完了のTaskはありません"}</small>
                  </Link>
                </li>
              );
            })}
          </ul>
          {open.length > storyDisplayLimit && <p className="section-note">ほか{open.length - storyDisplayLimit}件は「実行」で確認してください。</p>}
        </>
      )}
      {settled > 0 && <p className="section-note">完了・取消のStoryが{settled}件あります。</p>}
      <Link to={projectViewPath(projectId, "work")} className="text-link">実行を開く →</Link>
    </>
  );
};

const actionTarget = (projectId: string, action: MyAction): string => {
  switch (action.kind) {
    case "accept": return projectViewPath(projectId, "work", taskAnchorId(action.taskId));
    case "grant": return projectViewPath(projectId, "settings", agentRoleAnchorId(action.role));
    case "credential": return projectViewPath(projectId, "settings", credentialSectionId);
  }
};

/** あなたの操作 1件。実行できるものはリンク（ボタン）、できないものは依頼先の文言にする。 */
const MyActionItem = ({ projectId, action }: { projectId: string; action: MyAction }) => (
  <li>
    {action.allowed ? <Link to={actionTarget(projectId, action)} className="button compact">{action.label}</Link> : <span>{action.label}</span>}
    {action.kind === "credential" && <small>Credentialの無いAgent: {action.principalIds.join("、")}</small>}
    {!action.allowed && "requestTo" in action && <small>{action.requestTo}</small>}
  </li>
);

/** Agentの担当待ち 1区分。Humanが代行できないためボタンにせず、担当Roleと根拠の詳細へのリンクを出す。 */
const WaitingItemRow = ({ projectId, workspaceId, item }: { projectId: string; workspaceId: string | null; item: WaitingItem }) => (
  <li>
    <span><span className={statusBadgeClass(waitingTones[item.kind])}>{waitingLabels[item.kind]}</span> {item.count}件 — {item.note}{item.unassigned && <strong className="waiting-unassigned">（{grantRoleLabels[item.role]}が未割当）</strong>}</span>
    {item.outcomes.length > 0 && workspaceId !== null && <small>{item.outcomes.map((outcome, index) => <span key={outcome.id}>{index > 0 && "、"}<Link to={workspaceOutcomePath(workspaceId, outcome.intentId, outcome.id)}>{outcome.title}</Link></span>)}</small>}
    {item.taskIds[0] && <small><Link to={projectViewPath(projectId, "work", taskAnchorId(item.taskIds[0]))}>該当Taskへ</Link></small>}
  </li>
);

const NextActions = ({ projectId, workspaceId, data, archived, permissions, now, onReload, pending }: {
  projectId: string;
  workspaceId: string | null;
  data: OverviewData;
  archived: boolean;
  permissions: OverviewPermissions;
  now: number;
  onReload: () => void;
  pending: boolean;
}) => {
  if (archived) return <p className="unset">アーカイブ済みのため、次の行動はありません。</p>;
  if (!data.execution.ok || !data.grants.ok) return <p role="alert" className="error-title">Story・TaskまたはAgentの割当を確認できないため、次の行動を判定できません。</p>;
  const direction = data.direction?.ok ? data.direction.value : null;
  const credentials = data.credentials?.ok ? data.credentials.value : null;
  const next = planNextActions({
    contributions: direction ? projectContributions(direction.outcomes, projectId) : null,
    tasks: data.execution.value.tasks,
    assignedRoles: new Set(data.grants.value.map((grant) => grant.role)),
    agentsWithoutCredential: credentials ? agentsWithoutCredential(data.grants.value, credentials.filter((item) => credentialStatus(item, now) === "active")) : null,
    permissions,
    now,
  });
  const summary = nextActionSummary(next);
  return (
    <>
      {summary && <p className="next-action-summary">{summary}</p>}
      {next.mine.length > 0 && (
        <>
          <p className="section-label">あなたの操作</p>
          <ul className="next-action-list">{next.mine.map((action) => <MyActionItem key={action.kind === "grant" ? `grant-${action.role}` : action.kind} projectId={projectId} action={action} />)}</ul>
        </>
      )}
      {next.waiting.length > 0 && (
        <>
          <p className="section-label">Agentの担当待ち</p>
          <p className="section-note">このProjectのAgentが次に動く必要のあるOutcomeとTaskです。Role割当済みでも、Agentが動いていることは示しません。</p>
          <ul className="next-action-list waiting">{next.waiting.map((item) => <WaitingItemRow key={item.kind} projectId={projectId} workspaceId={workspaceId} item={item} />)}</ul>
        </>
      )}
      {next.outcomeFailures > 0 && (
        <p role="alert" className="error-title">
          一部のOutcome（{next.outcomeFailures}件）の還流・評価の状態を確認できません。{" "}
          <button type="button" className="secondary-button compact" disabled={pending} onClick={onReload}>再読込</button>
        </p>
      )}
      {data.direction !== null && !data.direction.ok && <p className="section-note">Intent・Outcomeを読み込めないため、Story起票・Task分解・還流の担当待ちは判定していません。</p>}
      {data.credentials !== null && !data.credentials.ok && <p className="section-note">Credentialを読み込めないため、Credentialの無いAgentは判定していません。</p>}
    </>
  );
};

/**
 * Project詳細の概要（S10-03）。Projectを実行境界として、Purpose・Resource、貢献するWorkspace Outcome、実行状況、次の行動、Claim、
 * Project Activityを実データで集約する。部分ごとに取得失敗・空・閲覧不可を区別し、導線の表示だけを権限で切り替える（拒否は常にserver）。
 * ほかのTarget ProjectのWorkは件数だけにし、Role割当・Credential・ClaimからAgentが動作中であるとは表示しない。
 */
export const ProjectOverview = ({ project, direction, archived, permissions }: { project: Project; direction: OverviewDirectionAccess; archived: boolean; permissions: OverviewPermissions }) => {
  const projectId = project.id;
  const workspaceId = direction.workspaceId;
  const [data, setData] = useState<OverviewData | null>(null);
  const [pending, setPending] = useState(false);
  // 判定の基準時刻。取得時刻から始め、表示中にClaimの期限を過ぎたときだけ進める（「Claim保持中」と同じ判定にそろえる）。
  const [now, setNow] = useState(0);
  const { credentialManage } = permissions;
  const load = useCallback((isCurrent: () => boolean = () => true) => {
    setPending(true);
    return loadOverview(projectId, workspaceId, credentialManage)
      .then((loaded) => { if (isCurrent()) { setData(loaded); setNow(loaded.fetchedAt); } })
      .finally(() => { if (isCurrent()) setPending(false); });
  }, [projectId, workspaceId, credentialManage]);
  useEffect(() => {
    let current = true;
    setData(null);
    void load(() => current);
    return () => { current = false; };
  }, [load]);
  const expiry = data?.execution.ok ? nextClaimExpiry(data.execution.value.tasks, now) : null;
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(expiry - Date.now() + 1, 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiry, now]);
  return (
    <>
      <ExecutionBoundary project={project} direction={direction} />
      <div className="claim-holder-toolbar">
        <span>{data ? `${formatTime(data.fetchedAt)} 取得` : "未取得"}</span>
        <button type="button" className="secondary-button compact" disabled={pending} onClick={() => void load()}>
          {pending ? "読み込み中..." : "再読込"}
        </button>
      </div>
      {!data ? <Loading /> : (
        <>
          <section className="detail-section" aria-labelledby="contributions-heading">
            <h2 id="contributions-heading">貢献するOutcome</h2>
            <p className="section-note">Outcomeは所属Workspaceのもので、このProjectはTarget ProjectとしてStory・Taskで貢献します。Taskの受入はOutcomeの達成ではなく、達成はEvaluatorが全Target Projectの結果から評価します。</p>
            <Contributions projectId={projectId} direction={direction} data={data} />
            {workspaceId !== null && <Link to={workspacePath(workspaceId, "direction")} className="text-link">Workspaceの方向を開く →</Link>}
          </section>
          <section className="detail-section" aria-labelledby="work-progress-heading">
            <h2 id="work-progress-heading">実行状況</h2>
            <p className="section-note">Taskの状態ごとの件数です。作業中・レビュー待ちはTaskの状態で、Agentの稼働を示しません。</p>
            <WorkProgress projectId={projectId} execution={data.execution} now={now} />
          </section>
          <section className="detail-section" aria-labelledby="next-actions-heading">
            <h2 id="next-actions-heading">次の行動</h2>
            <NextActions projectId={projectId} workspaceId={workspaceId} data={data} archived={archived} permissions={permissions} now={now} onReload={() => void load()} pending={pending} />
          </section>
        </>
      )}
      <ClaimHolderSection projectId={projectId} />
      {data && (
        <section className="detail-section" aria-labelledby="project-recent-heading">
          <h2 id="project-recent-heading">最近の記録</h2>
          {!data.activities.ok ? <ErrorState message={`記録の読み込みに失敗しました: ${data.activities.error}`} /> : data.activities.value.length === 0 ? <p className="unset">Projectの記録はまだありません。</p> : <RecentActivityList activities={data.activities.value} />}
          <Link to={projectViewPath(projectId, "records")} className="text-link">記録を開く →</Link>
        </section>
      )}
    </>
  );
};
