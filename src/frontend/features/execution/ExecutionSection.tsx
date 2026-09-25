import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { taskPath } from "../../paths";
import {
  appendChangePage,
  changeNote,
  changesPath,
  changeTypeLabel,
  describeClaim,
  executionPath,
  formatTime,
  groupTasksByStory,
  isSettledTask,
  storyStatusLabels,
  taskStatusLabels,
  type ChangePage,
  type ExecutionChange,
  type ExecutionOverview,
  type ExecutionTask,
  type StoryGroup,
} from "./execution";

const TaskRow = ({ task }: { task: ExecutionTask }) => (
  <li>
    <Link to={taskPath(task.projectId, task.id)}>
      <span className={`status-badge${isSettledTask(task.status) ? " muted" : ""}`}>{taskStatusLabels[task.status]}</span> {task.title}
      <small>
        {describeClaim(task)} ・ {formatTime(task.updatedAt)} 更新
      </small>
    </Link>
  </li>
);

/** Story 1件とその配下のTask。Outcome由来のStoryには相関IDを出す。 */
export const StoryCard = ({ group }: { group: StoryGroup }) => {
  const { story, tasks } = group;
  return (
    <article className="intent-card execution-story">
      <h3>
        <span className={`status-badge${story.status === "done" || story.status === "canceled" ? " muted" : ""}`}>{storyStatusLabels[story.status]}</span> {story.title}
      </h3>
      {story.description && <p className="section-note">{story.description}</p>}
      <p className="execution-meta">
        {story.correlationId ? <>相関ID <code>{story.correlationId}</code></> : "手動起票（Outcome無し）"} ・ {formatTime(story.updatedAt)} 更新
      </p>
      {tasks.length ? <ul className="outcome-list">{tasks.map((task) => <TaskRow key={task.id} task={task} />)}</ul> : <p className="unset">Taskは未登録です</p>}
    </article>
  );
};

export const StoryList = ({ overview, empty }: { overview: ExecutionOverview; empty: string }) => {
  const { groups, unassigned } = groupTasksByStory(overview);
  if (!groups.length && !unassigned.length) return <p className="unset">{empty}</p>;
  return (
    <>
      {groups.map((group) => <StoryCard key={group.story.id} group={group} />)}
      {unassigned.length > 0 && (
        <article className="intent-card execution-story">
          <h3>Storyに属さないTask</h3>
          <ul className="outcome-list">{unassigned.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
        </article>
      )}
    </>
  );
};

/** Execution Change Logの1件。Taskの変更は、Task名でTask詳細へ辿るリンクにする。 */
export const ChangeItem = ({ change, taskTitles, projectId }: { change: ExecutionChange; taskTitles?: ReadonlyMap<string, string>; projectId: string }) => {
  const taskTitle = taskTitles?.get(change.entityId);
  const note = changeNote(change);
  return (
    <li>
      <span className="status-badge muted">{changeTypeLabel(change.type)}</span>{" "}
      {taskTitle !== undefined ? <Link to={taskPath(projectId, change.entityId)}>{taskTitle}</Link> : null}
      <small>
        #{change.cursor} ・ {change.principalId} ・ {formatTime(change.occurredAt)}
        {change.correlationId && <> ・ 相関ID <code>{change.correlationId}</code></>}
      </small>
      {note && <p className="section-note">理由: {note}</p>}
    </li>
  );
};

/** Projectの「最近の変更」。新しい順に取得し、「さらに古い変更」でcursorを辿る。 */
const RecentChanges = ({ projectId, taskTitles }: { projectId: string; taskTitles: ReadonlyMap<string, string> }) => {
  const [changes, setChanges] = useState<ExecutionChange[] | null>(null);
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
    setChanges(null);
    setError(null);
    request<ChangePage>(changesPath(projectId))
      .then((page) => { if (current) { setChanges(page.changes); setNextCursor(page.nextCursor); } })
      .catch((reason: unknown) => { if (current) setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")); });
    return () => { current = false; };
  }, [projectId]);
  const loadMore = async () => {
    if (nextCursor === null || pending) return;
    setPending(true);
    setMoreError(null);
    try {
      const page = await request<ChangePage>(changesPath(projectId, nextCursor));
      setChanges((existing) => appendChangePage(existing ?? [], page.changes));
      setNextCursor(page.nextCursor);
      if (page.nextCursor === null) setReachedEnd(true);
    } catch (reason) {
      setMoreError(`古い変更を読み込めませんでした: ${loadFailureMessage(classifyError(reason), "Projectが見つかりません。")}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="execution-changes">
      <h3 id="changes-heading">最近の変更</h3>
      {error ? (
        <ErrorState message={`変更履歴の読み込みに失敗しました: ${error}`} />
      ) : changes === null ? (
        <Loading />
      ) : changes.length ? (
        <>
          <ul className="grant-list change-list" aria-labelledby="changes-heading">
            {changes.map((change) => <ChangeItem key={change.cursor} change={change} taskTitles={taskTitles} projectId={projectId} />)}
          </ul>
          {moreError && <p role="alert" className="error-title">{moreError}</p>}
          {reachedEnd && <p ref={endNote} tabIndex={-1} className="unset">これより古い変更はありません</p>}
          {nextCursor !== null && (
            <div className="action-row">
              <button type="button" className="secondary-button" disabled={pending} onClick={() => void loadMore()}>
                {pending ? "読み込み中..." : "さらに古い変更"}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="unset">変更はまだありません</p>
      )}
    </div>
  );
};

/**
 * Project詳細のExecution section（Human向け読取専用）。Story・Task・Claim・Change LogはAgent（MCP）が作り、
 * この画面からは変更しない。受入・差戻し・取消・手動起票は未実装（Task 46・47）。
 */
export const ExecutionSection = ({ projectId }: { projectId: string }) => {
  const [overview, setOverview] = useState<ExecutionOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setOverview(null);
    setError(null);
    request<ExecutionOverview>(executionPath(projectId))
      .then((body) => { if (current) setOverview(body); })
      .catch((reason: unknown) => { if (current) setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")); });
    return () => { current = false; };
  }, [projectId]);
  return (
    <section className="detail-section" aria-labelledby="execution-heading">
      <h2 id="execution-heading">Execution</h2>
      <p className="section-note">
        Manager・Worker・ReviewerのAgentがMCPで進めるStory・Taskです。この画面は参照専用で、受入・差戻しや手動起票はまだできません。
      </p>
      {error ? (
        <ErrorState message={`Executionの読み込みに失敗しました: ${error}`} />
      ) : overview === null ? (
        <Loading />
      ) : (
        <>
          <StoryList overview={overview} empty="Storyは未登録です" />
          <RecentChanges projectId={projectId} taskTitles={new Map(overview.tasks.map((task) => [task.id, task.title]))} />
        </>
      )}
    </section>
  );
};
