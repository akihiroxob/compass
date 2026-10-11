import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentPath, researchRequestPath, taskPath } from "../../paths";
import { describePrincipal, formatTime } from "../execution";
import { workspaceOutcomePath, workspacePath } from "../workspace/workspace";
import {
  activitiesPath,
  activityPath,
  activitySourceLabels,
  activityTypeGroups,
  activityTypeLabel,
  activityListReducer,
  activityTypeSearch,
  describeReference,
  initialActivityList,
  parseActivityTypeFilter,
  type ActivityDetail,
  type ActivityPage,
  type ActivityReference,
  type ActivityScope,
  type ActivitySummary,
  type ProjectResourceLink,
  type ReferenceView,
} from "./activity";

/**
 * Web UI内の画面。Task・Intent・Research RequestはProject配下のrouteのため、Project Activityからだけ辿る。
 * OutcomeはWorkspaceのOutcome詳細（Workspace Membershipで閲覧）、Workspace ActivityのIntentはWorkspaceの「方向」へ辿る。
 */
const screenPath = (scope: ActivityScope, workspaceId: string, screen: NonNullable<ReferenceView["screen"]>): string | null => {
  if (screen.kind === "outcome") return workspaceOutcomePath(workspaceId, screen.intentId, screen.id);
  if (scope.kind === "workspace") return screen.kind === "intent" ? workspacePath(workspaceId, "direction") : null;
  return screen.kind === "task"
    ? taskPath(scope.projectId, screen.id)
    : screen.kind === "intent"
      ? intentPath(scope.projectId, screen.id)
      : researchRequestPath(scope.projectId, screen.id);
};

const ReferenceItem = ({ scope, activity, reference, resources }: { scope: ActivityScope; activity: ActivitySummary; reference: ActivityReference; resources: readonly ProjectResourceLink[] | null }) => {
  const view = describeReference(reference, resources, activity.refs);
  const screen = view.screen ? screenPath(scope, activity.workspaceId, view.screen) : null;
  const label = view.href ? (
    <a href={view.href} target="_blank" rel="noreferrer">{view.label}<span className="visually-hidden">（外部の正本を新しいタブで開く）</span></a>
  ) : screen ? (
    <Link to={screen}>{view.label}</Link>
  ) : (
    <code>{view.label}</code>
  );
  return <li>{label}{view.detail && <> <code>{view.detail}</code></>}</li>;
};

/** 概要の「最近の記録」。新しい順のsummaryと記録者・日時だけを出し、本文・参照は「記録」で読む。 */
export const RecentActivityList = ({ activities }: { activities: readonly ActivitySummary[] }) => (
  <ul className="recent-activities">
    {activities.map((activity) => <li key={activity.id}>{activity.summary}<small>{describePrincipal(activity.principalId)}（{activity.role}） ・ {formatTime(activity.occurredAt)}</small></li>)}
  </ul>
);

/** 本文と訂正。必要になったActivityだけ、開いたときに取得する。 */
const ActivityBody = ({ scope, activityId }: { scope: ActivityScope; activityId: string }) => {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = activityPath(scope, activityId);
  useEffect(() => {
    let current = true;
    request<ActivityDetail>(path)
      .then((body) => { if (current) setDetail(body); })
      .catch((reason: unknown) => { if (current) setError(loadFailureMessage(classifyError(reason), "Activityが見つかりません。")); });
    return () => { current = false; };
  }, [path]);
  if (error) return <ErrorState message={`本文の読み込みに失敗しました: ${error}`} />;
  if (!detail) return <Loading />;
  return (
    <>
      {detail.activity.body && <p className="pre-wrap">{detail.activity.body}</p>}
      {detail.corrections.length > 0 && (
        <p className="section-note">
          訂正: {detail.corrections.map((correction) => `${correction.summary}（#${correction.cursor}）`).join(" / ")}
        </p>
      )}
    </>
  );
};

/** 種別。状態変更は表示名を添える。絞り込んでいなければ、同じ種別だけに絞り込むリンクにする。 */
const ActivityType = ({ scope, type, filtered }: { scope: ActivityScope; type: string; filtered: boolean }) => {
  const [searchParams] = useSearchParams();
  const label = activityTypeLabel(scope.kind, type);
  const text = <>{label && <>{label} </>}<code>{type}</code></>;
  return filtered ? text : <Link to={{ search: activityTypeSearch(searchParams, type) }}>{text}<span className="visually-hidden">（この種別だけを表示）</span></Link>;
};

const ActivityItem = ({ activity, scope, resources, filtered }: { activity: ActivitySummary; scope: ActivityScope; resources: readonly ProjectResourceLink[] | null; filtered: boolean }) => {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <span className="status-badge muted">{activitySourceLabels[activity.source]}</span> {activity.summary}
      <small>
        #{activity.cursor} ・ <ActivityType scope={scope} type={activity.type} filtered={filtered} /> ・ {describePrincipal(activity.principalId)}（{activity.role}） ・ {formatTime(activity.occurredAt)}
        {activity.correctsActivityId && <> ・ Activity <code>{activity.correctsActivityId.slice(0, 8)}</code> の訂正</>}
      </small>
      {activity.refs.length > 0 && (
        <ul className="activity-refs" aria-label="参照">
          {activity.refs.map((reference, index) => <ReferenceItem key={index} scope={scope} activity={activity} reference={reference} resources={resources} />)}
        </ul>
      )}
      {activity.hasBody && (
        <div className="action-row">
          <button type="button" className="secondary-button compact" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "本文を閉じる" : "本文を表示"}<span className="visually-hidden">（{activity.summary}）</span>
          </button>
        </div>
      )}
      {open && <ActivityBody scope={scope} activityId={activity.id} />}
    </li>
  );
};

/** 種別の絞り込み。URLの`?type=`を置き換え、`view`等の他のqueryは残す。一覧に無い種別（明示記録）で絞り込み中ならその種別も選択肢に出す。 */
const ActivityTypeFilter = ({ scope, current }: { scope: ActivityScope; current: string | null }) => {
  const id = useId();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const groups = activityTypeGroups[scope.kind];
  const known = current === null || activityTypeLabel(scope.kind, current) !== null;
  return (
    <div className="activity-filter">
      <label htmlFor={id}>種別</label>
      <select id={id} value={current ?? ""} onChange={(event) => navigate({ search: activityTypeSearch(searchParams, event.target.value || null) })}>
        <option value="">すべて</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.types.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
          </optgroup>
        ))}
        {!known && <optgroup label="記録"><option value={current}>{current}</option></optgroup>}
      </select>
    </div>
  );
};

const scopeNotes: Record<ActivityScope["kind"], string> = {
  project: "このProjectのWork（Story・Task）とProjectの履歴です。Intent・Outcome・Research・DecisionなどDirectionの判断は、所属Workspaceの記録にあります。",
  workspace: "このWorkspaceのDirection（Intent・Outcome・Research・Decision・評価）の判断の履歴です。各ProjectのStory・Taskの履歴は、Projectの記録にあります。",
};

/**
 * ProjectまたはWorkspaceのActivity（意味のある履歴）。Agentが記録した調査・判断・引き継ぎと、重要な状態変更から生成した履歴を
 * 新しい順に表示する。Project ActivityはStory・Task等のWork、Workspace ActivityはIntent・Outcome等のDirectionの履歴で、
 * 互いを含めない。Claim操作等のChange Log・運用ログは含めない。成果物は正本（Repository / Docs・URL）へのlinkだけで、本文はCompassに複製しない。
 * 種別はURLの`?type=`で絞り込み、再読込・共有で同じ一覧へ戻る。読み取り専用。`resources`は`project_resource`参照の表示に使う登録済みの
 * Repository・Resource（取得できなければnull）、`related`は他のscopeの記録への導線。
 */
export const ActivitySection = ({ scope, resources, related }: { scope: ActivityScope; resources: readonly ProjectResourceLink[] | null; related?: ReactNode }) => {
  const notFound = scope.kind === "project" ? "Projectが見つかりません。" : "Workspaceが見つかりません。";
  const [searchParams] = useSearchParams();
  const type = parseActivityTypeFilter(searchParams.get("type"));
  const scopeKey = `${scope.kind === "project" ? `project:${scope.projectId}` : `workspace:${scope.workspaceId}`}#${type ?? ""}`;
  const [list, dispatch] = useReducer(activityListReducer, scopeKey, initialActivityList);
  // 条件の変更直後（reset前）の描画では、前の条件の一覧を出さず読込中にする。
  const { activities, nextCursor, error, moreError, pending, reachedEnd } = list.key === scopeKey ? list : initialActivityList(scopeKey);
  // 最後のページを読み込むとbuttonが消えるため、focusをbodyへ落とさず末尾の案内へ移す。
  const endNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (reachedEnd) endNote.current?.focus(); }, [reachedEnd]);
  // 取得条件ごとに状態を作り直す。古い条件の応答（追加読込を含む）はreducerがkeyの不一致で捨てる。
  useEffect(() => {
    const key = scopeKey;
    dispatch({ kind: "reset", key });
    request<ActivityPage>(activitiesPath(scope, { type }))
      .then((page) => dispatch({ kind: "loaded", key, page }))
      .catch((reason: unknown) => dispatch({ kind: "failed", key, message: loadFailureMessage(classifyError(reason), notFound) }));
  }, [scopeKey]);
  const loadMore = async () => {
    if (nextCursor === null || pending) return;
    const key = scopeKey;
    dispatch({ kind: "moreStarted", key });
    try {
      const page = await request<ActivityPage>(activitiesPath(scope, { beforeCursor: nextCursor, type }));
      dispatch({ kind: "moreLoaded", key, page });
    } catch (reason) {
      dispatch({ kind: "moreFailed", key, message: `古いActivityを読み込めませんでした: ${loadFailureMessage(classifyError(reason), notFound)}` });
    }
  };
  const typeLabel = type === null ? null : (activityTypeLabel(scope.kind, type) ?? type);
  return (
    <section className="detail-section" aria-labelledby="activity-heading">
      <h2 id="activity-heading">Activity</h2>
      <p className="section-note">
        {scopeNotes[scope.kind]}成果物の本文はRepository・Docs側が正本で、ここでは参照先だけを表示します。Claim操作などの変更ログ・運用ログは含めません。
        {related && <> {related}</>}
      </p>
      <ActivityTypeFilter scope={scope} current={type} />
      {error ? (
        <ErrorState message={`Activityの読み込みに失敗しました: ${error}`} />
      ) : activities === null ? (
        <Loading />
      ) : activities.length ? (
        <>
          <ul className="grant-list change-list" aria-labelledby="activity-heading">
            {activities.map((activity) => <ActivityItem key={activity.cursor} activity={activity} scope={scope} resources={resources} filtered={type !== null} />)}
          </ul>
          {moreError && <p role="alert" className="error-title">{moreError}</p>}
          {reachedEnd && <p ref={endNote} tabIndex={-1} className="unset">これより古いActivityはありません</p>}
          {nextCursor !== null && (
            <div className="action-row">
              <button type="button" className="secondary-button" disabled={pending} onClick={() => void loadMore()}>
                {pending ? "読み込み中..." : "さらに古いActivity"}
              </button>
            </div>
          )}
        </>
      ) : type !== null ? (
        <p className="unset">種別「{typeLabel}」のActivityはありません。<Link to={{ search: activityTypeSearch(searchParams, null) }}>すべての種別を表示</Link></p>
      ) : (
        <p className="unset">Activityはまだありません</p>
      )}
    </section>
  );
};
