import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, LinkButton } from "../../components/ui";
import { storyEditPath, taskCreatePath, taskPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import {
  appendChangePage,
  changeEditSummary,
  changeNote,
  changeTarget,
  changesPath,
  changeTypeLabel,
  describeClaim,
  describePrincipal,
  formatTime,
  groupTasksByStory,
  isManualOpenStory,
  storyAnchorId,
  storyStatusLabels,
  taskAnchorId,
  taskStatusLabels,
  type ChangePage,
  type ChangeTarget,
  type ExecutionChange,
  type ExecutionOverview,
  type ExecutionTask,
  type StoryGroup,
  storyStatusTones,
  taskTone,
} from "./execution";

const TaskRow = ({ task }: { task: ExecutionTask }) => (
  <li id={taskAnchorId(task.id)} tabIndex={-1}>
    <Link to={taskPath(task.projectId, task.id)}>
      <span className={statusBadgeClass(taskTone(task))}>{taskStatusLabels[task.status]}</span> {task.title}
      <small>
        {describeClaim(task)} ・ {formatTime(task.updatedAt)} 更新
      </small>
    </Link>
  </li>
);

/**
 * Story 1件とその配下のTask。Outcome由来のStoryには相関IDを出す。`plan`（手動起票の権限があり、Projectがactive）のときは、
 * 手動起票で開いているStoryにだけ編集・Task追加の導線を出す（Task 47）。
 */
export const StoryCard = ({ group, plan = false }: { group: StoryGroup; plan?: boolean }) => {
  const { story, tasks } = group;
  return (
    <article id={storyAnchorId(story.id)} tabIndex={-1} className="intent-card execution-story">
      <h3>
        <span className={statusBadgeClass(storyStatusTones[story.status])}>{storyStatusLabels[story.status]}</span> {story.title}
      </h3>
      {story.description && <p className="section-note">{story.description}</p>}
      <p className="execution-meta">
        {story.correlationId ? <>相関ID <code>{story.correlationId}</code></> : "手動起票（Outcome無し）"} ・ {formatTime(story.updatedAt)} 更新
      </p>
      {tasks.length ? <ul className="outcome-list">{tasks.map((task) => <TaskRow key={task.id} task={task} />)}</ul> : <p className="unset">Taskはまだありません</p>}
      {plan && isManualOpenStory(story) && (
        <div className="action-row">
          <LinkButton variant="secondary" size="sm" to={taskCreatePath(story.projectId, story.id)}>このStoryにTaskを追加<span className="visually-hidden">（{story.title}）</span></LinkButton>
          <LinkButton variant="secondary" size="sm" to={storyEditPath(story.projectId, story.id)}>Storyを編集<span className="visually-hidden">（{story.title}）</span></LinkButton>
        </div>
      )}
    </article>
  );
};

export const StoryList = ({ overview, empty, plan = false }: { overview: ExecutionOverview; empty: string; plan?: boolean }) => {
  const { groups, unassigned } = groupTasksByStory(overview);
  if (!groups.length && !unassigned.length) return <p className="unset">{empty}</p>;
  return (
    <>
      {groups.map((group) => <StoryCard key={group.story.id} group={group} plan={plan} />)}
      {unassigned.length > 0 && (
        <article className="intent-card execution-story">
          <h3>Storyに属さないTask</h3>
          <ul className="outcome-list">{unassigned.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
        </article>
      )}
    </>
  );
};

/** Changeの対象。TaskはTask詳細へ、Storyは同じ画面のStory cardへ辿る。一覧に無いStoryはIDだけを出す。 */
const ChangeTargetLabel = ({ target, projectId }: { target: ChangeTarget; projectId: string }) => {
  if (target.kind === "task") return <Link to={taskPath(projectId, target.id)}>{target.title ?? <>Task <code>{target.id}</code></>}</Link>;
  if (target.title === null) return <>Story <code>{target.id}</code></>;
  return <>Story「{target.title}」</>;
};

/** Execution Change Logの1件。`target`（「最近の変更」だけ）があれば、対象のTask・Storyを出す。 */
export const ChangeItem = ({ change, target, projectId, humanNames }: { change: ExecutionChange; target?: ChangeTarget | null; projectId: string; humanNames?: ReadonlyMap<string, string> }) => {
  const note = changeNote(change);
  const edited = changeEditSummary(change);
  return (
    <li>
      <span className="status-badge muted">{changeTypeLabel(change.type)}</span>{" "}
      {target ? <ChangeTargetLabel target={target} projectId={projectId} /> : null}
      <small>
        #{change.cursor} ・ {describePrincipal(change.principalId, humanNames)} ・ {formatTime(change.occurredAt)}
        {change.correlationId && <> ・ 相関ID <code>{change.correlationId}</code></>}
      </small>
      {edited && <p className="section-note">変更: {edited}</p>}
      {note && <p className="section-note">理由: {note}</p>}
    </li>
  );
};

/** Projectの「最近の変更」。新しい順に取得し、「さらに古い変更」でcursorを辿る。 */
export const RecentChanges = ({ projectId }: { projectId: string }) => {
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
            {changes.map((change) => <ChangeItem key={change.cursor} change={change} target={changeTarget(change)} projectId={projectId} />)}
          </ul>
          {moreError && <p role="alert" className="error-title">{moreError}</p>}
          {reachedEnd && <p ref={endNote} tabIndex={-1} className="unset">これより古い変更はありません</p>}
          {nextCursor !== null && (
            <div className="action-row">
              <Button variant="secondary" pending={pending} onClick={() => void loadMore()}>
                {pending ? "読み込み中..." : "さらに古い変更"}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="unset">変更はまだありません</p>
      )}
    </div>
  );
};
