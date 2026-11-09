import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, classifyError, jsonInit, jsonPost, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ProjectOperationGate } from "../access";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Field, LinkButton, TextArea, TextInput } from "../../components/ui";
import { taskPath } from "../../paths";
import {
  executionItemFormValues,
  executionPath,
  executionViewPath,
  isManualEditableTask,
  isManualOpenStory,
  storiesApiPath,
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
import { allOutcomes, workApiPath, type WorkPage, type WorkStoryItem } from "./work";

// Human手動起票（Task 47。U4）の作成・編集画面。Outcome handoffのStory・TaskはManagerが管理するため、ここでは扱わない。

type Heading = { eyebrow: string; title: string; lede: string };
type Saved = { to: string };

/** Story・Task共通のフォーム。保存に失敗しても入力は残し、そのまま再送信できる。 */
const ExecutionItemForm = ({
  projectId,
  subject,
  initial,
  heading,
  submitLabel,
  pendingLabel,
  cancelTo,
  target,
  storyId = null,
  save,
}: {
  projectId: string;
  subject: "Story" | "Task";
  initial: ExecutionItemFormValues;
  heading: Heading;
  submitLabel: string;
  pendingLabel: string;
  cancelTo: string;
  /** Task起票だけ。所属先（対象Story、またはStoryに属さない）を固定で表示する。選ばせない。 */
  target?: ReactNode;
  /** Task起票で固定する対象Story。nullはStoryに属さないTask。 */
  storyId?: string | null;
  save: (values: ExecutionItemFormValues & { storyId: string | null }) => Promise<Saved>;
}) => {
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const saved = await save({ title, description, storyId });
      navigate(saved.to);
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), `Projectまたは${subject}が見つかりません。削除されたか、閲覧する権限がありません。`));
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <main className="narrow">
      <Link to={cancelTo} className="back-link">← 戻る</Link>
      <div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div>
      <p className="lede">{heading.lede}</p>
      {error && <FormErrorSummary error={error} detailTo={executionViewPath(projectId)} conflict={{ title: `この${subject}は変更できない状態です。`, action: <Link to={executionViewPath(projectId)} className="text-link">実行で最新の状態を確認する →</Link> }} />}
      <form onSubmit={submit} className="project-form execution-form" noValidate>
        <section className="form-section">
          <Field label="タイトル" required description={`${subject}を一言で表す名前（200文字まで）`}>
            <TextInput {...fieldProps(invalid, "field-title")} required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="説明" description={subject === "Task" ? "作業内容と完了条件。Agentはこの説明を読んで作業します（任意）。" : "このStoryで実現すること（任意）。"}>
            <TextArea {...fieldProps(invalid, "field-description")} placeholder={subject === "Task" ? "例: 作業内容と、完了と判断する条件" : "例: 実現したいことと、受入の条件"} maxLength={10000} rows={6} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          {target && <Field label="所属先" description="この起票では変更できません。">{target}</Field>}
        </section>
        <div className="form-actions">
          <LinkButton to={cancelTo} variant="secondary">キャンセル</LinkButton>
          <Button type="submit" pending={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</Button>
        </div>
      </form>
    </main>
  );
};

/** 読込中・失敗・編集できない理由の表示。 */
const Blocked = ({ back, children }: { back: { to: string; label: string }; children: ReactNode }) => (
  <main className="narrow"><Link to={back.to} className="back-link">{back.label}</Link>{children}</main>
);

const useLoaded = <T,>(path: string, notFound: (reason: unknown) => string, enabled = true) => {
  const [state, setState] = useState<{ path: string; value: T | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    request<T>(path)
      .then((value) => { if (current) setState({ path, value, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ path, value: null, error: notFound(reason) }); });
    return () => { current = false; };
  }, [path, enabled]);
  return state?.path === path ? state : null;
};

const projectNotFound = (reason: unknown) => loadFailureMessage(classifyError(reason), "Projectが見つかりません。");

export const StoryCreatePage = () => {
  const { projectId = "" } = useParams();
  const back = { to: executionViewPath(projectId), label: "← 実行" };
  return (
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={back}>
      <ExecutionItemForm
        projectId={projectId}
        subject="Story"
        initial={executionItemFormValues()}
        heading={{ eyebrow: "New story", title: "Storyを追加", lede: "Humanが手動でStoryを作ります。OutcomeからのStoryはManagerのAgentが起票するため、ここでは作りません。" }}
        submitLabel="Storyを追加"
        pendingLabel="追加中..."
        cancelTo={back.to}
        save={async ({ title, description }) => {
          const { story } = await request<{ story: ExecutionStory }>(storiesApiPath(projectId), jsonPost({ title, description }));
          return { to: executionViewPath(projectId, story.id) };
        }}
      />
    </ProjectOperationGate>
  );
};

const StoryEditForm = ({ projectId, storyId }: { projectId: string; storyId: string }) => {
  const loaded = useLoaded<ExecutionOverview>(executionPath(projectId), projectNotFound);
  const back = { to: executionViewPath(projectId, storyId), label: "← 実行" };
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
        return { to: executionViewPath(projectId, storyId) };
      }}
    />
  );
};

export const StoryEditPage = () => {
  const { projectId = "", storyId = "" } = useParams();
  return (
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={{ to: executionViewPath(projectId), label: "← 実行" }}>
      <StoryEditForm key={`${projectId}/${storyId}`} projectId={projectId} storyId={storyId} />
    </ProjectOperationGate>
  );
};

const TaskCreateForm = ({ projectId, requestedStoryId }: { projectId: string; requestedStoryId: string | null }) => {
  const back = { to: executionViewPath(projectId, requestedStoryId ?? undefined), label: "← 実行" };
  // 対象Storyが指定されたときだけ、そのStory1件を取得する。大量のStoryを読み込んで選ばせない。
  const loaded = useLoaded<WorkPage>(
    requestedStoryId ? workApiPath(projectId, { mode: "stories", q: "", status: "all", outcome: allOutcomes, story: requestedStoryId, page: 1 }) : "",
    projectNotFound,
    requestedStoryId !== null,
  );
  let target: ReactNode = <p className="form-fixed-target">Storyに属さないTask</p>;
  let lede = "Humanが手動でTaskを作ります。起票したTaskは未着手になり、WorkerのAgentが引き受けられます。このTaskはStoryに属しません。";
  if (requestedStoryId) {
    if (!loaded) return <Blocked back={back}><Loading /></Blocked>;
    if (loaded.error || !loaded.value) return <Blocked back={back}><ErrorState message={loaded.error ?? "Storyが見つかりません。"} /></Blocked>;
    const item = loaded.value.items.find((candidate): candidate is WorkStoryItem => candidate.kind === "story" && candidate.story.id === requestedStoryId);
    if (!item) return <Blocked back={back}><ErrorState message="Storyが見つかりません。別ProjectのStoryか、削除された可能性があります。" /></Blocked>;
    if (!isManualOpenStory(item.story)) {
      return <Blocked back={back}><ErrorState message={item.story.correlationId ? "OutcomeからManagerが起票したStoryには、HumanがTaskを追加できません。" : `${storyStatusLabels[item.story.status]}のStoryにはTaskを追加できません。`} /></Blocked>;
    }
    target = <p className="form-fixed-target">{item.story.title}（{storyStatusLabels[item.story.status]}のStory）</p>;
    lede = "このStoryにTaskを追加します。起票したTaskは未着手になり、WorkerのAgentが引き受けられます。";
  }
  return (
    <ExecutionItemForm
      projectId={projectId}
      subject="Task"
      initial={executionItemFormValues()}
      heading={{ eyebrow: "New task", title: "Taskを追加", lede }}
      submitLabel="Taskを追加"
      pendingLabel="追加中..."
      cancelTo={back.to}
      target={target}
      storyId={requestedStoryId}
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
    <ProjectOperationGate projectId={projectId} operation="execution.plan" back={{ to: executionViewPath(projectId), label: "← 実行" }}>
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
