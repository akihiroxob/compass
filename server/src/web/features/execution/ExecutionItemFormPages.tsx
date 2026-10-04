import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, classifyError, jsonInit, jsonPost, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ProjectOperationGate } from "../../components/ProjectOperationGate";
import { Shell } from "../../components/Shell";
import { ErrorState, Loading } from "../../components/StateCard";
import { taskPath } from "../../paths";
import {
  executionItemFormValues,
  executionPath,
  initialTaskStoryId,
  isManualEditableTask,
  isManualOpenStory,
  manualTaskStoryOptions,
  storiesApiPath,
  storyAnchorId,
  storyStatusLabels,
  taskDetailApiPath,
  tasksApiPath,
  taskStatusLabels,
  type ExecutionItemFormValues,
  type ExecutionOverview,
  type ExecutionStory,
  type ExecutionTask,
  type TaskDetail,
} from "./execution";

// Human手動起票（Task 47。U4）の作成・編集画面。Outcome handoffのStory・TaskはManagerが管理するため、ここでは扱わない。

type Heading = { eyebrow: string; title: string; lede: string };
type Saved = { to: string };

const projectDetail = (projectId: string) => `/projects/${projectId}`;
const storyAnchor = (projectId: string, storyId: string) => `${projectDetail(projectId)}#${storyAnchorId(storyId)}`;

/** Story・Task共通のフォーム。保存に失敗しても入力は残し、そのまま再送信できる。 */
const ExecutionItemForm = ({
  projectId,
  subject,
  initial,
  heading,
  submitLabel,
  pendingLabel,
  cancelTo,
  storyOptions,
  initialStoryId = "",
  save,
}: {
  projectId: string;
  subject: "Story" | "Task";
  initial: ExecutionItemFormValues;
  heading: Heading;
  submitLabel: string;
  pendingLabel: string;
  cancelTo: string;
  /** Task起票だけ。対象Storyを選ぶ（空はStoryに属さないTask）。 */
  storyOptions?: ExecutionStory[];
  initialStoryId?: string;
  save: (values: ExecutionItemFormValues & { storyId: string | null }) => Promise<Saved>;
}) => {
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [storyId, setStoryId] = useState(initialStoryId);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const saved = await save({ title, description, storyId: storyId || null });
      navigate(saved.to);
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), `Projectまたは${subject}が見つかりません。削除されたか、閲覧する権限がありません。`));
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <Shell>
      <main className="narrow">
        <Link to={cancelTo} className="back-link">← 戻る</Link>
        <div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div>
        <p className="lede">{heading.lede}</p>
        {error && <FormErrorSummary error={error} projectDetailTo={projectDetail(projectId)} conflict={{ title: `この${subject}は変更できない状態です。`, action: <Link to={projectDetail(projectId)} className="text-link">Project詳細で最新の状態を確認する →</Link> }} />}
        <form onSubmit={submit} className="project-form execution-form" noValidate>
          <section className="form-section">
            <label>
              タイトル <span>必須</span>
              <small>{subject}を一言で表す名前（200文字まで）</small>
              <input {...fieldProps(invalid, "field-title")} required aria-required="true" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              説明
              <small>{subject === "Task" ? "作業内容と完了条件。Agentはこの説明を読んで作業します（任意）。" : "このStoryで実現すること（任意）。"}</small>
              <textarea {...fieldProps(invalid, "field-description")} maxLength={10000} rows={6} value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            {storyOptions && (
              <label>
                対象Story
                <small>手動起票した、完了・取消していないStoryから選びます。OutcomeからManagerが起票したStoryには追加できません。</small>
                <select {...fieldProps(invalid, "field-storyId")} value={storyId} onChange={(event) => setStoryId(event.target.value)}>
                  <option value="">Storyに属さないTask</option>
                  {storyOptions.map((story) => <option key={story.id} value={story.id}>{story.title}（{storyStatusLabels[story.status]}）</option>)}
                </select>
              </label>
            )}
          </section>
          <div className="form-actions">
            <Link to={cancelTo} className="secondary-button">キャンセル</Link>
            <button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button>
          </div>
        </form>
      </main>
    </Shell>
  );
};

/** 読込中・失敗・編集できない理由の表示。 */
const Blocked = ({ back, children }: { back: { to: string; label: string }; children: ReactNode }) => (
  <Shell><main className="narrow"><Link to={back.to} className="back-link">{back.label}</Link>{children}</main></Shell>
);

const useLoaded = <T,>(path: string, notFound: (reason: unknown) => string) => {
  const [state, setState] = useState<{ path: string; value: T | null; error: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    request<T>(path)
      .then((value) => { if (current) setState({ path, value, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ path, value: null, error: notFound(reason) }); });
    return () => { current = false; };
  }, [path]);
  return state?.path === path ? state : null;
};

const projectNotFound = (reason: unknown) => loadFailureMessage(classifyError(reason), "Projectが見つかりません。");

export const StoryCreatePage = () => {
  const { projectId = "" } = useParams();
  const back = { to: projectDetail(projectId), label: "← Project詳細" };
  return (
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={back}>
      <ExecutionItemForm
        projectId={projectId}
        subject="Story"
        initial={executionItemFormValues()}
        heading={{ eyebrow: "New story", title: "Storyを起票", lede: "Humanが手動でStoryを作ります。OutcomeからのStoryはManagerのAgentが起票するため、ここでは作りません。" }}
        submitLabel="Storyを起票"
        pendingLabel="起票中..."
        cancelTo={back.to}
        save={async ({ title, description }) => {
          const { story } = await request<{ story: ExecutionStory }>(storiesApiPath(projectId), jsonPost({ title, description }));
          return { to: storyAnchor(projectId, story.id) };
        }}
      />
    </ProjectOperationGate>
  );
};

const StoryEditForm = ({ projectId, storyId }: { projectId: string; storyId: string }) => {
  const loaded = useLoaded<ExecutionOverview>(executionPath(projectId), projectNotFound);
  const back = { to: storyAnchor(projectId, storyId), label: "← Project詳細" };
  if (!loaded) return <Blocked back={back}><Loading /></Blocked>;
  if (loaded.error || !loaded.value) return <Blocked back={back}><ErrorState message={loaded.error ?? "Storyが見つかりません。"} /></Blocked>;
  const story = loaded.value.stories.find((candidate) => candidate.id === storyId);
  if (!story) return <Blocked back={back}><ErrorState message="Storyが見つかりません。別ProjectのStoryか、削除された可能性があります。" /></Blocked>;
  if (!isManualOpenStory(story)) {
    return <Blocked back={back}><ErrorState message={story.correlationId ? "OutcomeからManagerが起票したStoryは、Humanが編集できません。" : `${storyStatusLabels[story.status]}のStoryは編集できません。`} /></Blocked>;
  }
  return (
    <ExecutionItemForm
      projectId={projectId}
      subject="Story"
      initial={executionItemFormValues(story)}
      heading={{ eyebrow: "Edit story", title: "Storyを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }}
      submitLabel="変更を保存"
      pendingLabel="保存中..."
      cancelTo={back.to}
      save={async ({ title, description }) => {
        await request(storiesApiPath(projectId, storyId), jsonInit("PATCH", { title, description }));
        return { to: storyAnchor(projectId, storyId) };
      }}
    />
  );
};

export const StoryEditPage = () => {
  const { projectId = "", storyId = "" } = useParams();
  return (
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={{ to: projectDetail(projectId), label: "← Project詳細" }}>
      <StoryEditForm key={`${projectId}/${storyId}`} projectId={projectId} storyId={storyId} />
    </ProjectOperationGate>
  );
};

const TaskCreateForm = ({ projectId, requestedStoryId }: { projectId: string; requestedStoryId: string | null }) => {
  const loaded = useLoaded<ExecutionOverview>(executionPath(projectId), projectNotFound);
  const back = { to: requestedStoryId ? storyAnchor(projectId, requestedStoryId) : projectDetail(projectId), label: "← Project詳細" };
  if (!loaded) return <Blocked back={back}><Loading /></Blocked>;
  if (loaded.error || !loaded.value) return <Blocked back={back}><ErrorState message={loaded.error ?? "Projectが見つかりません。"} /></Blocked>;
  const options = manualTaskStoryOptions(loaded.value.stories);
  return (
    <ExecutionItemForm
      projectId={projectId}
      subject="Task"
      initial={executionItemFormValues()}
      heading={{
        eyebrow: "New task",
        title: "Taskを起票",
        lede: options.length
          ? "Humanが手動でTaskを作ります。起票したTaskは未着手になり、WorkerのAgentが引き受けられます。"
          : "Humanが手動でTaskを作ります。Taskを追加できるStoryが無いため、Storyに属さないTaskになります（先にStoryを起票することもできます）。",
      }}
      submitLabel="Taskを起票"
      pendingLabel="起票中..."
      cancelTo={back.to}
      storyOptions={options}
      initialStoryId={initialTaskStoryId(requestedStoryId, options)}
      save={async ({ title, description, storyId }) => {
        const { task } = await request<{ task: ExecutionTask }>(tasksApiPath(projectId), jsonPost({ title, description, storyId }));
        return { to: taskPath(projectId, task.id) };
      }}
    />
  );
};

export const TaskCreatePage = () => {
  const { projectId = "" } = useParams();
  const [search] = useSearchParams();
  return (
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={{ to: projectDetail(projectId), label: "← Project詳細" }}>
      <TaskCreateForm key={projectId} projectId={projectId} requestedStoryId={search.get("storyId")} />
    </ProjectOperationGate>
  );
};

const taskNotFound = (reason: unknown) =>
  reason instanceof ApiError && reason.status === 404 && reason.message.startsWith("Task")
    ? "Taskが見つかりません。別ProjectのTaskか、削除されたTaskの可能性があります。"
    : projectNotFound(reason);

const TaskEditForm = ({ projectId, taskId }: { projectId: string; taskId: string }) => {
  const loaded = useLoaded<TaskDetail>(taskDetailApiPath(projectId, taskId), taskNotFound);
  const back = { to: taskPath(projectId, taskId), label: "← Task詳細" };
  if (!loaded) return <Blocked back={back}><Loading /></Blocked>;
  if (loaded.error || !loaded.value) return <Blocked back={back}><ErrorState message={loaded.error ?? "Taskが見つかりません。"} /></Blocked>;
  const { task, story } = loaded.value;
  if (!isManualEditableTask(task, story)) {
    return <Blocked back={back}><ErrorState message={task.taskKey || story?.correlationId ? "OutcomeからManagerが起票したTaskは、Humanが編集できません。" : `${taskStatusLabels[task.status]}のTaskは編集できません。`} /></Blocked>;
  }
  return (
    <ExecutionItemForm
      projectId={projectId}
      subject="Task"
      initial={executionItemFormValues(task)}
      heading={{ eyebrow: "Edit task", title: "Taskを編集", lede: `タイトルと説明を変更します。対象Story（${story ? story.title : "Storyに属さない"}）と状態は変わりません。作業中のAgentには変更が通知されないため、必要ならCommentで伝えてください。` }}
      submitLabel="変更を保存"
      pendingLabel="保存中..."
      cancelTo={back.to}
      save={async ({ title, description }) => {
        await request(tasksApiPath(projectId, taskId), jsonInit("PATCH", { title, description }));
        return { to: taskPath(projectId, taskId) };
      }}
    />
  );
};

export const TaskEditPage = () => {
  const { projectId = "", taskId = "" } = useParams();
  return (
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={{ to: taskPath(projectId, taskId), label: "← Task詳細" }}>
      <TaskEditForm key={`${projectId}/${taskId}`} projectId={projectId} taskId={taskId} />
    </ProjectOperationGate>
  );
};
