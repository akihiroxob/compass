import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { splitIntents, type Intent } from "../../intentForm";
import { splitOutcomes, type Outcome } from "../../outcomeForm";
import { intentPath, outcomePath, workspaceApiPath } from "../../paths";
import { statusBadgeClass, type StatusTone } from "../../statusTone";
import { credentialSectionId, credentialStatus, credentialsPath, type Credential } from "../credential";
import {
  evaluationsPath,
  executionPath,
  executionSummaryPath,
  formatTime,
  outcomeLoopStage,
  taskAnchorId,
  taskStatusLabels,
  type ExecutionOverview,
  type ExecutionTask,
  type LoopStage,
  type OutcomeEvaluation,
  type OutcomeExecutionRecord,
  taskStatusTones,
} from "../execution";
import { agentRoleAnchorId, grantRoleLabels, grantsPath, type Grant } from "../grant";
import {
  agentsWithoutCredential,
  countWork,
  nextClaimExpiry,
  nextActionSummary,
  planNextActions,
  projectViewPath,
  type MyAction,
  type OutcomeProgress,
  type OverviewOutcome,
  type OverviewPermissions,
  type WaitingItem,
  type WaitingKind,
  type WorkBucket,
} from "./overview";

const workBucketLabels: Record<WorkBucket, string> = { ...taskStatusLabels, reclaimable: "再取得待ち" };
const waitingLabels: Record<WaitingKind, string> = { ...workBucketLabels, story: "Story起票待ち", evaluation: "評価待ち", reflection: "還流待ち" };
const workBucketTones: Record<WorkBucket, StatusTone> = { ...taskStatusTones, reclaimable: "warning" };
const waitingTones: Record<WaitingKind, StatusTone> = { ...workBucketTones, story: "waiting", evaluation: "waiting", reflection: "waiting" };

/** 評価段に並べるOutcomeの上限。残りはOutcome詳細へ誘導する（担当待ちの件数は全Active Outcomeで数える）。 */
const stageDisplayLimit = 5;

/** 判定（`OutcomeProgress`）に、評価段の表示用のラベルを持たせたもの。 */
type LoadedProgress = OutcomeProgress & { stage: LoopStage | null };

type OverviewData = {
  activeIntent: Intent | null;
  outcomes: Outcome[];
  progress: LoadedProgress[];
  tasks: ExecutionTask[];
  grants: Grant[];
  credentials: Credential[] | null;
  fetchedAt: number;
};

const toOverviewOutcome = (outcome: Outcome): OverviewOutcome => ({ id: outcome.id, intentId: outcome.intentId, title: outcome.title });

/** Active Outcome 1件の閉ループの現在地。取得に失敗したOutcomeは`stage: null`にし、件数に含めない。 */
const loadProgress = (projectId: string, workspaceId: string, outcome: Outcome): Promise<LoadedProgress> =>
  Promise.all([
    request<ExecutionOverview>(executionPath(projectId, outcome.id)),
    request<{ record: OutcomeExecutionRecord | null }>(executionSummaryPath(projectId, outcome.id)),
    request<{ evaluations: OutcomeEvaluation[] }>(evaluationsPath(workspaceId, outcome.id)),
  ])
    .then(([overview, { record }, { evaluations }]) => ({
      outcome: toOverviewOutcome(outcome),
      stage: outcomeLoopStage({ storyCount: overview.stories.length, record, evaluations }),
      tasks: overview.tasks,
    }))
    .catch(() => ({ outcome: toOverviewOutcome(outcome), stage: null, tasks: [] }));

/** Intent・Outcomeは所属WorkspaceのDirection。WorkspaceのDirectionを閲覧できない（`workspaceId`がnull）場合は読まない。 */
const loadOverview = async (projectId: string, workspaceId: string | null, showCredentials: boolean): Promise<OverviewData> => {
  const [{ intents }, { tasks }, { grants }, credentials] = await Promise.all([
    workspaceId === null ? Promise.resolve({ intents: [] as Intent[] }) : request<{ intents: Intent[] }>(workspaceApiPath(workspaceId, "/intents")),
    request<ExecutionOverview>(executionPath(projectId)),
    request<{ grants: Grant[] }>(grantsPath(projectId)),
    showCredentials ? request<{ credentials: Credential[] }>(credentialsPath(projectId)).then((body) => body.credentials) : Promise.resolve(null),
  ]);
  const { active: activeIntent } = splitIntents(intents);
  const outcomes = activeIntent && workspaceId !== null
    ? splitOutcomes((await request<{ outcomes: Outcome[] }>(workspaceApiPath(workspaceId, `/intents/${activeIntent.id}/outcomes`))).outcomes).active
    : [];
  const progress = workspaceId === null ? [] : await Promise.all(outcomes.map((outcome) => loadProgress(projectId, workspaceId, outcome)));
  return { activeIntent, outcomes, progress, tasks, grants, credentials, fetchedAt: Date.now() };
};

const outcomeDetailPath = (projectId: string, outcome: OverviewOutcome) => outcomePath(projectId, outcome.intentId, outcome.id);

/** 現在地: Direction（Intent・Outcome）→ Work → 評価。各段から根拠の詳細へ辿る。Executionの受入をOutcomeの達成として出さない。 */
const CurrentPosition = ({ projectId, data, now }: { projectId: string; data: OverviewData; now: number }) => {
  const work = countWork(data.tasks, now);
  const shown = data.progress.slice(0, stageDisplayLimit);
  return (
    <ol className="position-steps" aria-label="現在地">
      <li>
        <p className="section-label">Intent</p>
        {data.activeIntent ? <Link to={intentPath(projectId, data.activeIntent.id)}>{data.activeIntent.title}</Link> : <p className="unset">未登録</p>}
      </li>
      <li>
        <p className="section-label">Outcome</p>
        {data.outcomes.length ? (
          <>
            <p className="position-count">Active {data.outcomes.length}件</p>
            <ul>{data.outcomes.slice(0, stageDisplayLimit).map((outcome) => <li key={outcome.id}><Link to={outcomePath(projectId, outcome.intentId, outcome.id)}>{outcome.title}</Link></li>)}</ul>
          </>
        ) : <p className="unset">{data.activeIntent ? "未登録" : "Intentの登録後に設定します"}</p>}
      </li>
      <li>
        <p className="section-label">Work</p>
        {work.length ? (
          <Link to={projectViewPath(projectId, "work")} className="position-work">
            {work.map(({ bucket, count }) => <span key={bucket}><span className={statusBadgeClass(workBucketTones[bucket])}>{workBucketLabels[bucket]}</span> {count}件</span>)}
          </Link>
        ) : <p className="unset">進行中のTaskはありません</p>}
      </li>
      <li>
        <p className="section-label">評価</p>
        {shown.length ? (
          <ul>
            {shown.map(({ outcome, stage }) => (
              <li key={outcome.id}>
                <Link to={outcomeDetailPath(projectId, outcome)}>{outcome.title}</Link>
                <small>{stage ? stage.label : "確認できません"}</small>
              </li>
            ))}
          </ul>
        ) : <p className="unset">Active Outcomeがありません</p>}
        {data.progress.length > shown.length && <p className="section-note">ほか{data.progress.length - shown.length}件はOutcome詳細で確認してください。</p>}
      </li>
    </ol>
  );
};

const actionTarget = (projectId: string, activeIntentId: string | null, action: MyAction): string => {
  switch (action.kind) {
    case "intent": return intentPath(projectId, "new");
    case "outcome": return activeIntentId ? outcomePath(projectId, activeIntentId, "new") : projectViewPath(projectId, "direction");
    case "accept": return projectViewPath(projectId, "work", taskAnchorId(action.taskId));
    case "grant": return projectViewPath(projectId, "settings", agentRoleAnchorId(action.role));
    case "credential": return projectViewPath(projectId, "settings", credentialSectionId);
  }
};

/** あなたの操作 1件。実行できるものはリンク（ボタン）、できないものは依頼先の文言にする。 */
const MyActionItem = ({ projectId, activeIntentId, action }: { projectId: string; activeIntentId: string | null; action: MyAction }) => (
  <li>
    {action.allowed ? <Link to={actionTarget(projectId, activeIntentId, action)} className="button compact">{action.label}</Link> : <span>{action.label}</span>}
    {action.kind === "credential" && <small>Credentialの無いAgent: {action.principalIds.join("、")}</small>}
    {!action.allowed && "requestTo" in action && <small>{action.requestTo}</small>}
  </li>
);

/** Agentの担当待ち 1区分。Humanが代行できないためボタンにせず、担当Roleと根拠の詳細へのリンクを出す。 */
const WaitingItemRow = ({ projectId, item }: { projectId: string; item: WaitingItem }) => (
  <li>
    <span><span className={statusBadgeClass(waitingTones[item.kind])}>{waitingLabels[item.kind]}</span> {item.count}件 — {item.note}{item.unassigned && <strong className="waiting-unassigned">（{grantRoleLabels[item.role]}が未割当）</strong>}</span>
    {item.outcomes.length > 0 && <small>{item.outcomes.map((outcome, index) => <span key={outcome.id}>{index > 0 && "、"}<Link to={outcomeDetailPath(projectId, outcome)}>{outcome.title}</Link></span>)}</small>}
    {item.taskIds[0] && <small><Link to={projectViewPath(projectId, "work", taskAnchorId(item.taskIds[0]))}>該当Taskへ</Link></small>}
  </li>
);

/**
 * Project詳細の概要（Task 03）。現在地と、権限に応じた次の行動をまとめる。導線の表示だけを権限で切り替え、拒否は常にserverが行う。
 * archivedでは次の行動を出さない。Role割当・Credential・Claimから、Agentが動作中であるとは表示しない。
 */
export const ProjectOverview = ({ projectId, workspaceId, archived, permissions }: { projectId: string; workspaceId: string | null; archived: boolean; permissions: OverviewPermissions }) => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 判定の基準時刻。取得時刻から始め、表示中にClaimの期限を過ぎたときだけ進める（「Claim保持中」と同じ判定にそろえる）。
  const [now, setNow] = useState(0);
  const { credentialManage } = permissions;
  const load = useCallback((isCurrent: () => boolean = () => true) => {
    setPending(true);
    setError(null);
    return loadOverview(projectId, workspaceId, credentialManage)
      .then((loaded) => { if (isCurrent()) { setData(loaded); setNow(loaded.fetchedAt); } })
      .catch((reason: unknown) => { if (isCurrent()) setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")); })
      .finally(() => { if (isCurrent()) setPending(false); });
  }, [projectId, workspaceId, credentialManage]);
  useEffect(() => {
    let current = true;
    setData(null);
    void load(() => current);
    return () => { current = false; };
  }, [load]);
  const expiry = data ? nextClaimExpiry([...data.tasks, ...data.progress.flatMap((item) => item.tasks)], now) : null;
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(expiry - Date.now() + 1, 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiry, now]);
  const next = data && !archived
    ? planNextActions({
        activeIntentId: data.activeIntent?.id ?? null,
        outcomes: data.progress,
        tasks: data.tasks,
        assignedRoles: new Set(data.grants.map((grant) => grant.role)),
        agentsWithoutCredential: data.credentials ? agentsWithoutCredential(data.grants, data.credentials.filter((item) => credentialStatus(item, now) === "active")) : null,
        permissions,
        now,
      })
    : null;
  const summary = next ? nextActionSummary(next) : null;
  return (
    <section className="detail-section project-overview" aria-labelledby="overview-heading">
      <h2 id="overview-heading">現在地</h2>
      <div className="claim-holder-toolbar">
        <span>{data ? `${formatTime(data.fetchedAt)} 取得` : "未取得"}</span>
        <button type="button" className="secondary-button compact" disabled={pending} onClick={() => void load()}>
          {pending ? "読み込み中..." : "再読込"}
        </button>
      </div>
      {error ? (
        <ErrorState message={`概要の読み込みに失敗しました: ${error}`} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <CurrentPosition projectId={projectId} data={data} now={now} />
          <h3 id="next-actions-heading">次の行動</h3>
          {!next ? (
            <p className="unset">アーカイブ済みのため、次の行動はありません。</p>
          ) : (
            <>
              {summary && <p className="next-action-summary">{summary}</p>}
              {next.mine.length > 0 && (
                <>
                  <p className="section-label">あなたの操作</p>
                  <ul className="next-action-list">{next.mine.map((action) => <MyActionItem key={action.kind === "grant" ? `grant-${action.role}` : action.kind} projectId={projectId} activeIntentId={data.activeIntent?.id ?? null} action={action} />)}</ul>
                </>
              )}
              {next.waiting.length > 0 && (
                <>
                  <p className="section-label">Agentの担当待ち</p>
                  <p className="section-note">Agentが次に動く必要のあるOutcomeとTaskです。Role割当済みでも、Agentが動いていることは示しません。</p>
                  <ul className="next-action-list waiting">{next.waiting.map((item) => <WaitingItemRow key={item.kind} projectId={projectId} item={item} />)}</ul>
                </>
              )}
              {next.outcomeFailures > 0 && (
                <p role="alert" className="error-title">
                  一部のOutcome（{next.outcomeFailures}件）を確認できません。{" "}
                  <button type="button" className="secondary-button compact" disabled={pending} onClick={() => void load()}>再読込</button>
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
};
