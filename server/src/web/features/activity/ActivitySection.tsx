import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentPath, researchRequestPath, taskPath } from "../../paths";
import { describePrincipal, formatTime } from "../execution";
import {
  activitiesPath,
  activityPath,
  activitySourceLabels,
  appendActivityPage,
  describeReference,
  type ActivityDetail,
  type ActivityPage,
  type ActivityReference,
  type ActivitySummary,
  type ProjectResourceLink,
  type ReferenceView,
} from "./activity";

const screenPath = (projectId: string, screen: NonNullable<ReferenceView["screen"]>) =>
  screen.kind === "task"
    ? taskPath(projectId, screen.id)
    : screen.kind === "intent"
      ? intentPath(projectId, screen.id)
      : researchRequestPath(projectId, screen.id);

const ReferenceItem = ({ projectId, reference, resources }: { projectId: string; reference: ActivityReference; resources: readonly ProjectResourceLink[] }) => {
  const view = describeReference(reference, resources);
  const label = view.href ? (
    <a href={view.href} target="_blank" rel="noreferrer">{view.label}</a>
  ) : view.screen ? (
    <Link to={screenPath(projectId, view.screen)}>{view.label}</Link>
  ) : (
    <code>{view.label}</code>
  );
  return <li>{label}{view.detail && <> <code>{view.detail}</code></>}</li>;
};

/** 本文と訂正。必要になったActivityだけ、開いたときに取得する。 */
const ActivityBody = ({ projectId, activityId }: { projectId: string; activityId: string }) => {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    request<ActivityDetail>(activityPath(projectId, activityId))
      .then((body) => { if (current) setDetail(body); })
      .catch((reason: unknown) => { if (current) setError(loadFailureMessage(classifyError(reason), "Activityが見つかりません。")); });
    return () => { current = false; };
  }, [projectId, activityId]);
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

const ActivityItem = ({ activity, projectId, resources }: { activity: ActivitySummary; projectId: string; resources: readonly ProjectResourceLink[] }) => {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <span className="status-badge muted">{activitySourceLabels[activity.source]}</span> {activity.summary}
      <small>
        #{activity.cursor} ・ <code>{activity.type}</code> ・ {describePrincipal(activity.principalId)}（{activity.role}） ・ {formatTime(activity.occurredAt)}
        {activity.correctsActivityId && <> ・ Activity <code>{activity.correctsActivityId.slice(0, 8)}</code> の訂正</>}
      </small>
      {activity.refs.length > 0 && (
        <ul className="activity-refs">
          {activity.refs.map((reference, index) => <ReferenceItem key={index} projectId={projectId} reference={reference} resources={resources} />)}
        </ul>
      )}
      {activity.hasBody && (
        <div className="action-row">
          <button type="button" className="secondary-button compact" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "本文を閉じる" : "本文を表示"}<span className="visually-hidden">（{activity.summary}）</span>
          </button>
        </div>
      )}
      {open && <ActivityBody projectId={projectId} activityId={activity.id} />}
    </li>
  );
};

/**
 * ProjectのActivity（意味のある履歴）。Agentが記録した調査・判断・引き継ぎと、Story・Taskの重要な状態変更から生成した履歴を
 * 新しい順に表示する。成果物は正本（Repository / Docs・URL）へのlinkだけで、本文はCompassに複製しない。読み取り専用。
 */
export const ActivitySection = ({ projectId, resources }: { projectId: string; resources: readonly ProjectResourceLink[] }) => {
  const [activities, setActivities] = useState<ActivitySummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 最後のページを読み込むとbuttonが消えるため、focusをbodyへ落とさず末尾の案内へ移す。
  const [reachedEnd, setReachedEnd] = useState(false);
  const endNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (reachedEnd) endNote.current?.focus(); }, [reachedEnd]);
  useEffect(() => {
    let current = true;
    setReachedEnd(false);
    setActivities(null);
    setError(null);
    request<ActivityPage>(activitiesPath(projectId))
      .then((page) => { if (current) { setActivities(page.activities); setNextCursor(page.nextCursor); } })
      .catch((reason: unknown) => { if (current) setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")); });
    return () => { current = false; };
  }, [projectId]);
  const loadMore = async () => {
    if (nextCursor === null || pending) return;
    setPending(true);
    setMoreError(null);
    try {
      const page = await request<ActivityPage>(activitiesPath(projectId, nextCursor));
      setActivities((existing) => appendActivityPage(existing ?? [], page.activities));
      setNextCursor(page.nextCursor);
      if (page.nextCursor === null) setReachedEnd(true);
    } catch (reason) {
      setMoreError(`古いActivityを読み込めませんでした: ${loadFailureMessage(classifyError(reason), "Projectが見つかりません。")}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="detail-section" aria-labelledby="activity-heading">
      <h2 id="activity-heading">Activity</h2>
      <p className="section-note">
        AgentとHumanが後から経緯を辿るための履歴です。成果物の本文はRepository・Docs側が正本で、ここでは参照先だけを表示します。
      </p>
      {error ? (
        <ErrorState message={`Activityの読み込みに失敗しました: ${error}`} />
      ) : activities === null ? (
        <Loading />
      ) : activities.length ? (
        <>
          <ul className="grant-list change-list" aria-labelledby="activity-heading">
            {activities.map((activity) => <ActivityItem key={activity.cursor} activity={activity} projectId={projectId} resources={resources} />)}
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
      ) : (
        <p className="unset">Activityはまだありません</p>
      )}
    </section>
  );
};
