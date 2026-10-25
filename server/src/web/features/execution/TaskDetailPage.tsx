import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, classifyError, describeActionFailure, jsonPost, loadFailureMessage, request, type ErrorKind } from "../../api";
import { ReasonPanel, useReasonAction, type ReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, Field, LinkButton, TextArea } from "../../components/ui";
import { consultationPath, projectViewPath, taskEditPath } from "../../paths";
import { useProjectOperation, useProjectOperationState } from "../access";
import { membersPath, type Member } from "../member";
import { TaskOutcomeSection } from "./TaskOutcomeSection";
import { ChangeItem } from "./ExecutionSection";
import { statusBadgeClass } from "../../statusTone";
import {
  availableTaskOperations,
  describePrincipal,
  formatClaimExpiry,
  formatTime,
  isManualEditableTask,
  storyAnchorId,
  storyStatusLabels,
  taskAnchorId,
  taskDetailApiPath,
  taskOperationNotices,
  taskOperationPath,
  taskStatusLabels,
  type ExecutionStory,
  type ExecutionTask,
  type TaskDetail,
  type TaskOperation,
  taskTone,
} from "./execution";

/** 未所属・存在しないProjectと、別ProjectのTask IDはどちらも404（serverが区別を漏らさない）。 */
const taskLoadFailure = (reason: unknown) =>
  reason instanceof ApiError && reason.status === 404
    ? reason.message.startsWith("Task")
      ? "Taskが見つかりません。別ProjectのTaskか、削除されたTaskの可能性があります。"
      : "Projectが見つからないか、このProjectを閲覧する権限がありません。"
    : loadFailureMessage(classifyError(reason), "Taskが見つかりません。");

/** 介入の失敗。状態の競合（Agentが先に操作した・古い画面）は再読込を促す。入力は呼出し側で残す。 */
const describeOperationFailure = (classified: ErrorKind) =>
  classified.kind === "conflict"
    ? `${classified.message}（Taskの状態が変わった可能性があります。画面を再読込して最新の状態を確認してください）`
    : describeActionFailure(classified, "Taskが見つかりません。別ProjectのTaskか、閲覧する権限がありません。");

/** 操作の成功通知。表示のたびにfocusを移し、操作した導線が消えてもkeyboardの位置を失わない。 */
const OperationNotice = ({ notice }: { notice: { message: string; at: number } }) => {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), [notice]);
  return <p ref={ref} tabIndex={-1} className="grant-notice" role="status">{notice.message}</p>;
};

const operationPanels: Record<TaskOperation, { button: string; title: string; description: string; label?: string; confirm: string; pending: string; danger: boolean }> = {
  accept: {
    button: "受け入れる",
    title: "このTaskを受け入れますか？",
    description: "受入済みにすると、このTaskは完了として扱われ、Agentは再び作業できません。レビューを経ていない場合も、Humanの判断で受け入れます。",
    confirm: "受け入れる",
    pending: "受入中...",
    danger: false,
  },
  reject: {
    button: "差し戻す",
    title: "このTaskを差し戻しますか？",
    description: "差し戻すと、WorkerのAgentが理由を読んで作業をやり直します。理由はTask詳細と変更履歴に残ります。",
    label: "差戻しの理由",
    confirm: "差し戻す",
    pending: "差戻し中...",
    danger: true,
  },
  cancel: {
    button: "Taskを取消",
    title: "このTaskを取り消しますか？",
    description: "取り消すと元に戻せません。作業中のAgentのClaimは解放され、Agentはこのタスクを続けられなくなります。",
    label: "取消の理由",
    confirm: "取り消す",
    pending: "取消中...",
    danger: true,
  },
};

type OperationActions = Record<TaskOperation, ReasonAction>;

/** 受入・差戻し・取消の導線と確認パネル。開いているパネルは1つだけにする。 */
const TaskOperations = ({ operations, actions }: { operations: TaskOperation[]; actions: OperationActions }) => {
  if (!operations.length) return null;
  const open = (operation: TaskOperation) => {
    for (const other of operations) if (other !== operation) actions[other].cancel();
    actions[operation].open();
  };
  const opened = operations.find((operation) => actions[operation].confirming);
  return (
    <>
      <div className="action-row">
        {operations.map((operation) => (
          <Button
            key={operation}
            variant={operationPanels[operation].danger ? "secondary" : "primary"}
            tone={operationPanels[operation].danger ? "danger" : undefined}
            aria-expanded={actions[operation].confirming}
            onClick={() => open(operation)}
          >
            {operationPanels[operation].button}
          </Button>
        ))}
      </div>
      {opened && (() => {
        const panel = operationPanels[opened];
        return (
          <ReasonPanel
            key={opened}
            action={actions[opened]}
            title={panel.title}
            description={panel.description}
            {...(panel.label ? { label: panel.label, required: true } : {})}
            confirmLabel={panel.confirm}
            pendingLabel={panel.pending}
            danger={panel.danger}
          />
        );
      })()}
    </>
  );
};

/** Task詳細が読むProjectの項目（`GET /api/projects/:projectId`の`project`の一部）。 */
export type TaskProject = { name: string; status: "active" | "archived"; workspaceId: string };

/**
 * パンくずの先頭に置くWorkspaceの項目（`<li>`）。Workspaceの現在地はworkspaceが持つため、appが合成して渡す。
 * Projectを読めなければ呼ばない。
 */
export type WorkspaceCrumbs = (project: TaskProject) => ReactNode;

/**
 * Workspace → Project → 実行 → Story → Taskの現在位置。Workspaceの項目は`workspaceCrumbs`が閲覧できる場合だけ出し、Projectを
 * 読めなければProjectはIDで「実行」viewへ辿る。StoryとTaskの行は「実行」viewの該当cardへ移動する。
 */
const TaskBreadcrumb = ({ projectId, project, story, task, workspaceCrumbs }: { projectId: string; project: TaskProject | null; story: ExecutionStory | null; task: ExecutionTask; workspaceCrumbs: WorkspaceCrumbs }) => (
  <nav className="breadcrumb" aria-label="現在位置">
    <ol>
      {project && workspaceCrumbs(project)}
      <li><Link to={projectViewPath(projectId, "overview")}>{project?.name ?? "Project"}</Link></li>
      <li><Link to={projectViewPath(projectId, "work", taskAnchorId(task.id))}>実行</Link></li>
      {story && <li><Link to={projectViewPath(projectId, "work", storyAnchorId(story.id))}>{story.title}</Link></li>}
      <li aria-current="page">{task.title}</li>
    </ol>
  </nav>
);

/** Claimの保持者と期限。Claimは期限付きの作業権で、Agentプロセスの稼働状態を示さない。 */
const ClaimFacts = ({ task }: { task: ExecutionTask }) => {
  const now = Date.now();
  if (task.activeClaim && task.activeClaim.expiresAt > now) {
    return <>担当 <strong>{task.activeClaim.principalId}</strong>（期限 {formatTime(task.activeClaim.expiresAt)}・{formatClaimExpiry(task.activeClaim.expiresAt, now)}）</>;
  }
  if (task.activeClaim || task.reclaimable) return <>Claimの期限切れ（{task.status === "doing" ? "再取得待ち" : "Claimなし"}）</>;
  return <span className="unset">担当なし</span>;
};

/** HumanのComment入力。失敗時は入力を残し、成功時だけ空にする。通知はfocusを動かさずフォームの下に出す。 */
const CommentForm = ({ projectId, taskId, onAdded }: { projectId: string; taskId: string; onAdded: () => Promise<void> }) => {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) {
      setError("Commentを入力してください。");
      return;
    }
    setError(null);
    setAdded(false);
    setPending(true);
    try {
      await request(taskOperationPath(projectId, taskId, "comments"), jsonPost({ body }));
      setBody("");
      setAdded(true);
      await onAdded();
    } catch (reason) {
      setError(describeOperationFailure(classifyError(reason)));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="grant-form" onSubmit={submit} noValidate>
      <Field label="Commentを追加" required>
        <TextArea
          id="task-comment-body"
          required
          maxLength={10000}
          rows={3}
          value={body}
          {...(error ? { "aria-invalid": true, "aria-describedby": "task-comment-error" } : {})}
          onChange={(event) => { setBody(event.target.value); setAdded(false); }}
        />
      </Field>
      {error && (
        <StateCard ref={errorRef} tabIndex={-1} id="task-comment-error" tone="error" role="alert">
          {error}
        </StateCard>
      )}
      <div className="form-actions">
        <Button type="submit" pending={pending}>{pending ? "追加中..." : "Commentを追加"}</Button>
      </div>
      {added && <p className="grant-notice" role="status">{taskOperationNotices.comment}</p>}
    </form>
  );
};

/**
 * Task詳細（Task 45の閲覧、Task 46のHuman介入、S10-04のWorkspace導線）。Workspace → Project → 実行 → Storyの現在位置、説明・状態・
 * Claim・差戻し理由、Task受入とOutcome評価（Evidence）の区別、Comment・当該TaskのChangeを表示し、editor以上には状態に応じた
 * 受入・差戻し・取消とCommentの導線を出す（archivedでは出さない）。操作後はserverから読み直し、拒否は常にserverが行う。
 */
export const TaskDetailPage = ({ workspaceCrumbs }: { workspaceCrumbs: WorkspaceCrumbs }) => {
  const { projectId = "", taskId = "" } = useParams();
  const [state, setState] = useState<{ key: string; detail: TaskDetail | null; error: string | null } | null>(null);
  const [notice, setNotice] = useState<{ key: string; message: string; at: number } | null>(null);
  const [project, setProject] = useState<{ projectId: string; project: TaskProject | null } | null>(null);
  const [humanNames, setHumanNames] = useState<{ projectId: string; names: ReadonlyMap<string, string> } | null>(null);
  const key = `${projectId}/${taskId}`;
  const access = useProjectOperationState(projectId, "execution.intervene").access;
  const plan = useProjectOperation(projectId, "execution.plan");
  const load = useCallback(
    () => request<TaskDetail>(taskDetailApiPath(projectId, taskId)).then((detail) => setState({ key, detail, error: null })),
    [key],
  );
  useEffect(() => {
    let current = true;
    request<TaskDetail>(taskDetailApiPath(projectId, taskId))
      .then((detail) => { if (current) setState({ key, detail, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ key, detail: null, error: taskLoadFailure(reason) }); });
    return () => { current = false; };
  }, [key]);
  // 現在位置（Workspace・Project名）と、Outcome評価を読む所属Workspace。読めなくてもTask詳細は出す。
  useEffect(() => {
    let current = true;
    request<{ project: TaskProject }>(`/api/projects/${projectId}`)
      .then(({ project }) => project, () => null)
      .then((value) => { if (current) setProject({ projectId, project: value }); });
    return () => { current = false; };
  }, [projectId]);
  // Human operatorの表示名。取得できなくても画面は出す（IDの先頭で表示する）。
  useEffect(() => {
    let current = true;
    request<{ members: Member[] }>(membersPath(projectId))
      .then(({ members }) => { if (current) setHumanNames({ projectId, names: new Map(members.map((member) => [member.human.id, member.human.displayName])) }); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [projectId]);
  const operate = (operation: TaskOperation) => async (reason: string) => {
    if (operation !== "accept" && !reason.trim()) throw new Error(`${operationPanels[operation].label}を入力してください。`);
    await request(taskOperationPath(projectId, taskId, operation), jsonPost(operation === "accept" ? undefined : { reason }));
    setNotice({ key, message: taskOperationNotices[operation], at: Date.now() });
    await load().catch(() => setNotice({ key, message: `${taskOperationNotices[operation]}最新の状態を読み込めませんでした。画面を再読込してください。`, at: Date.now() }));
  };
  const actions: OperationActions = {
    accept: useReasonAction(operate("accept"), describeOperationFailure),
    reject: useReasonAction(operate("reject"), describeOperationFailure),
    cancel: useReasonAction(operate("cancel"), describeOperationFailure),
  };
  // route内でIDが変わった直後は、旧Taskの結果を描画しない。
  const settled = state?.key === key ? state : null;
  const detail = settled?.detail ?? null;
  const task = detail?.task;
  const names = humanNames?.projectId === projectId ? humanNames.names : undefined;
  const projectState = project?.projectId === projectId ? project : null;
  const currentNotice = notice?.key === key ? notice : null;
  const intervene = access === "allowed";
  return (
    <main className="narrow">
      {settled?.error ? (
        <>
          <Link to={projectViewPath(projectId, "work")} className="back-link">← 実行</Link>
          <ErrorState message={settled.error} />
        </>
      ) : !detail || !task ? (
        <Loading />
      ) : (
        <>
          <TaskBreadcrumb projectId={projectId} project={projectState?.project ?? null} story={detail.story} task={task} workspaceCrumbs={workspaceCrumbs} />
          <div className="detail-hero">
            <p className="eyebrow">Task</p>
            <h1>{task.title}</h1>
            <p><span className={statusBadgeClass(taskTone(task))}>{taskStatusLabels[task.status]}</span></p>
            <time>{formatTime(task.updatedAt)} 更新</time>
            {currentNotice && <OperationNotice notice={currentNotice} />}
            {plan && isManualEditableTask(task, detail.story) && (
              <div className="action-row"><LinkButton variant="secondary" to={taskEditPath(projectId, taskId)}>Taskを編集</LinkButton></div>
            )}
            {intervene && <TaskOperations operations={availableTaskOperations(task)} actions={actions} />}
            {intervene && (task.status === "in_review" || task.status === "wait_accept") && task.activeClaim && (
              <p className="section-note">Agentが受入・レビューのClaimを持っているため、受入・差戻しはClaimの解放後にできます。</p>
            )}
            {access === "archived" && <p className="section-note">アーカイブ済みのProjectのため、受入・差戻し・取消・Commentはできません。</p>}
          </div>
          <section className="detail-section" aria-labelledby="task-facts-heading">
            <h2 id="task-facts-heading">概要</h2>
            <dl className="intent-facts">
              <dt>説明</dt>
              <dd>{task.description ?? <span className="unset">未設定</span>}</dd>
              <dt>Story</dt>
              <dd>{detail.story ? <><Link to={projectViewPath(projectId, "work", storyAnchorId(detail.story.id))}>{detail.story.title}</Link>（{storyStatusLabels[detail.story.status]}）</> : <span className="unset">Storyに属していません</span>}</dd>
              {detail.story?.correlationId && <><dt>相関ID</dt><dd><code>{detail.story.correlationId}</code></dd></>}
              {task.taskKey && <><dt>taskKey</dt><dd><code>{task.taskKey}</code></dd></>}
              <dt>Claim</dt>
              <dd>
                <ClaimFacts task={task} />
                <small className="claim-note">Claimは期限付きの作業権で、Agentプロセスの稼働状態を示しません。</small>
              </dd>
              <dt>作成</dt>
              <dd>{formatTime(task.createdAt)}</dd>
            </dl>
          </section>
          {task.consultationWait && (
            <section className="detail-section" aria-labelledby="consultation-wait-heading">
              <h2 id="consultation-wait-heading">相談待ち・再開</h2>
              <p><span className={statusBadgeClass(task.consultationWait.state === "resuming" ? "progress" : "waiting")}>
                {{ waiting: "相談の結論待ち", ready: "再開待ち", resuming: "再開中" }[task.consultationWait.state]}
              </span> — {{ work: "作業", review: "レビュー", acceptance: "受入" }[task.consultationWait.phase]}の段階を保持しています</p>
              <ul>{task.consultationWait.consultations.map((ref) => (
                <li key={ref.id}><Link to={consultationPath(projectId, ref.id)}>相談 {ref.id.slice(0, 8)}</Link>（版 {ref.revision}）</li>
              ))}</ul>
              {task.consultationWait.failureReason && <p role="status" className="pre-wrap">{task.consultationWait.failureReason}</p>}
            </section>
          )}
          {task.rejectReason && (
            <section className="detail-section" aria-labelledby="reject-heading">
              <h2 id="reject-heading">差戻し理由</h2>
              <p className="pre-wrap">{task.rejectReason}</p>
            </section>
          )}
          {projectState ? (
            <TaskOutcomeSection projectId={projectId} workspaceId={projectState.project?.workspaceId ?? null} task={task} story={detail.story} />
          ) : (
            <Loading />
          )}
          <section className="detail-section" aria-labelledby="comments-heading">
            <h2 id="comments-heading">Comment</h2>
            <p className="section-note">AgentがClaimのもとで残した引継ぎ・検証の記録と、HumanのCommentです。</p>
            {detail.comments.length ? (
              <ul className="grant-list">
                {detail.comments.map((comment) => (
                  <li key={comment.id}>
                    <p className="pre-wrap">{comment.body}</p>
                    <small>{describePrincipal(comment.principalId, names)} ・ {formatTime(comment.createdAt)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="unset">Commentはありません</p>
            )}
            {intervene && (
              <CommentForm
                projectId={projectId}
                taskId={taskId}
                onAdded={() => load().catch(() => undefined)}
              />
            )}
          </section>
          <section className="detail-section" aria-labelledby="task-changes-heading">
            <h2 id="task-changes-heading">変更履歴</h2>
            {detail.changes.length ? (
              <ul className="grant-list change-list">
                {detail.changes.map((change) => <ChangeItem key={change.cursor} change={change} projectId={projectId} humanNames={names} />)}
              </ul>
            ) : (
              <p className="unset">変更はありません</p>
            )}
          </section>
        </>
      )}
    </main>
  );
};
