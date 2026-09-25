import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import { ChangeItem } from "./ExecutionSection";
import {
  describeClaim,
  formatTime,
  isSettledTask,
  storyStatusLabels,
  taskDetailApiPath,
  taskStatusLabels,
  type TaskDetail,
} from "./execution";

/** 未所属・存在しないProjectと、別ProjectのTask IDはどちらも404（serverが区別を漏らさない）。 */
const taskLoadFailure = (reason: unknown) =>
  reason instanceof ApiError && reason.status === 404
    ? reason.message.startsWith("Task")
      ? "Taskが見つかりません。別ProjectのTaskか、削除されたTaskの可能性があります。"
      : "Projectが見つからないか、このProjectを閲覧する権限がありません。"
    : loadFailureMessage(classifyError(reason), "Taskが見つかりません。");

/**
 * Task詳細（Human向け読取専用、Task 45）。説明・状態・Claim・差戻し理由・Comment・当該TaskのChangeを表示する。
 * 受入・差戻し・取消・Commentの操作はTask 46の範囲で、この画面にはまだ置かない。
 */
export const TaskDetailPage = () => {
  const { projectId = "", taskId = "" } = useParams();
  const [state, setState] = useState<{ key: string; detail: TaskDetail | null; error: string | null } | null>(null);
  const key = `${projectId}/${taskId}`;
  useEffect(() => {
    let current = true;
    request<TaskDetail>(taskDetailApiPath(projectId, taskId))
      .then((detail) => { if (current) setState({ key, detail, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ key, detail: null, error: taskLoadFailure(reason) }); });
    return () => { current = false; };
  }, [key]);
  // route内でIDが変わった直後は、旧Taskの結果を描画しない。
  const settled = state?.key === key ? state : null;
  const detail = settled?.detail ?? null;
  const task = detail?.task;
  return (
    <Shell>
      <main className="narrow">
        <Link to={`/projects/${projectId}`} className="back-link">← Project詳細</Link>
        {settled?.error ? (
          <ErrorState message={settled.error} />
        ) : !detail || !task ? (
          <Loading />
        ) : (
          <>
            <div className="detail-hero">
              <p className="eyebrow">Task</p>
              <h1>{task.title}</h1>
              <p><span className={`status-badge${isSettledTask(task.status) ? " muted" : ""}`}>{taskStatusLabels[task.status]}</span></p>
              <time>{formatTime(task.updatedAt)} 更新</time>
            </div>
            <section className="detail-section" aria-labelledby="task-facts-heading">
              <h2 id="task-facts-heading">概要</h2>
              <dl className="intent-facts">
                <dt>説明</dt>
                <dd>{task.description ?? <span className="unset">未設定</span>}</dd>
                <dt>Story</dt>
                <dd>{detail.story ? <>{detail.story.title}（{storyStatusLabels[detail.story.status]}）</> : <span className="unset">Storyに属していません</span>}</dd>
                {detail.story?.correlationId && <><dt>相関ID</dt><dd><code>{detail.story.correlationId}</code></dd></>}
                {task.taskKey && <><dt>taskKey</dt><dd><code>{task.taskKey}</code></dd></>}
                <dt>Claim</dt>
                <dd>{describeClaim(task)}</dd>
                <dt>作成</dt>
                <dd>{formatTime(task.createdAt)}</dd>
              </dl>
            </section>
            {task.rejectReason && (
              <section className="detail-section" aria-labelledby="reject-heading">
                <h2 id="reject-heading">差戻し理由</h2>
                <p className="pre-wrap">{task.rejectReason}</p>
              </section>
            )}
            <section className="detail-section" aria-labelledby="comments-heading">
              <h2 id="comments-heading">Comment</h2>
              <p className="section-note">AgentがClaimのもとで残した引継ぎ・検証の記録です。</p>
              {detail.comments.length ? (
                <ul className="grant-list">
                  {detail.comments.map((comment) => (
                    <li key={comment.id}>
                      <p className="pre-wrap">{comment.body}</p>
                      <small>{comment.principalId} ・ {formatTime(comment.createdAt)}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="unset">Commentはありません</p>
              )}
            </section>
            <section className="detail-section" aria-labelledby="task-changes-heading">
              <h2 id="task-changes-heading">変更履歴</h2>
              {detail.changes.length ? (
                <ul className="grant-list change-list">
                  {detail.changes.map((change) => <ChangeItem key={change.cursor} change={change} projectId={projectId} />)}
                </ul>
              ) : (
                <p className="unset">変更はありません</p>
              )}
            </section>
          </>
        )}
      </main>
    </Shell>
  );
};
