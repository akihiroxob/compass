import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Field, LinkButton, Select, TextInput } from "../../components/ui";
import { storyCreatePath, storyEditPath, taskCreatePath, taskPath, workspaceOutcomePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { useProjectOperationState } from "../access";
import { describeClaim, formatTime, isManualOpenStory, storyAnchorId, storyEmptyMessage, storyStatusLabels, storyStatusTones, taskStatusLabels, taskTone } from "./execution";
import { RecentChanges } from "./ExecutionSection";
import { loadWorkspaceOutcomes } from "./TaskOutcomeSection";
import type { TaskOutcomeRef } from "./execution";
import {
  allOutcomes,
  blockerSideLabels,
  clearedWorkSearch,
  hasWorkCondition,
  maximumWorkQueryLength,
  parseWorkQuery,
  progressDenominator,
  progressPercent,
  storyCriteria,
  taskBlocker,
  unsetOutcome,
  workApiPath,
  workBackState,
  workModeLabels,
  workModes,
  workSearch,
  workStatuses,
  workStatusLabel,
  type WorkItem,
  type WorkMode,
  type WorkPage,
  type WorkQuery,
  type WorkStatus,
  type WorkStoryItem,
  type WorkTaskItem,
} from "./work";

type OutcomeNames = { state: "loading" } | { state: "none" } | { state: "error" } | { state: "ready"; outcomes: TaskOutcomeRef[] };

const notFound = "Projectが見つかりません。";

/** StoryのOutcome。名称を取得できない場合は断定せず、その旨を示す。 */
const outcomeLabel = (outcomeId: string | null, names: OutcomeNames): string => {
  if (outcomeId === null) return "Outcome未設定";
  if (names.state === "ready") return names.outcomes.find((outcome) => outcome.id === outcomeId)?.title ?? "Outcome（名称を確認できません）";
  return names.state === "loading" ? "Outcome（読み込み中）" : "Outcome（名称を取得できません）";
};

const TaskRow = ({ projectId, item, backState, withContext, names }: { projectId: string; item: WorkTaskItem; backState: ReturnType<typeof workBackState>; withContext: boolean; names: OutcomeNames }) => {
  const { task, story } = item;
  const blocker = taskBlocker(task);
  return (
    <li className="work-task-row">
      <Link to={taskPath(projectId, task.id)} state={backState} className="work-task-title">
        <span className={statusBadgeClass(taskTone(task))}>{taskStatusLabels[task.status]}</span> {task.title}
      </Link>
      {withContext && <small className="work-task-context">{story ? `${story.title} ・ ${outcomeLabel(story.outcomeId, names)}` : "Storyに属さないTask"}</small>}
      {blocker && <small className="work-task-blocker"><strong>{blockerSideLabels[blocker.side]}</strong>: {blocker.reason}</small>}
      <small>{describeClaim(task)} ・ {formatTime(task.updatedAt)} 更新</small>
    </li>
  );
};

/**
 * Story 1件。1回開くと受入条件（説明）の全文とTaskが同時に見え、条件だけをさらに開く操作は置かない。
 * 手動起票のStory（`plan`）だけに、編集とTask追加をカード内へ置く。
 */
const StoryItem = ({ projectId, item, plan, defaultOpen, backState, names }: { projectId: string; item: WorkStoryItem; plan: boolean; defaultOpen: boolean; backState: ReturnType<typeof workBackState>; names: OutcomeNames }) => {
  const { story, tasks, taskCount, acceptedCount } = item;
  const criteria = storyCriteria(story);
  return (
    <article id={storyAnchorId(story.id)} tabIndex={-1} className="work-story">
      <details open={defaultOpen || undefined}>
        <summary className="work-story-summary">
          <span className="work-story-title"><span className={statusBadgeClass(storyStatusTones[story.status])}>{storyStatusLabels[story.status]}</span> {story.title}</span>
          <span className="work-story-scope">{outcomeLabel(story.outcomeId, names)}</span>
          <span className="work-story-count">{taskCount === 0 ? "Taskなし" : `受入済み ${acceptedCount} / ${taskCount}件`}{taskCount > 0 && tasks.length !== taskCount && <> ・ 該当Task {tasks.length}件</>}</span>
        </summary>
        <div className="work-story-body">
          <h4>受入条件・説明</h4>
          {story.description?.trim() && <p className="work-story-description">{story.description}</p>}
          {criteria.length > 0 && (
            <ol className="work-story-criteria">
              {criteria.map((item) => <li key={item.id}>{item.description}<small>測定: {item.measurement}{item.target ? ` ・ 目標: ${item.target}` : ""}</small></li>)}
            </ol>
          )}
          {!story.description?.trim() && criteria.length === 0 && <p className="unset">受入条件・説明は記録されていません</p>}
          <p className="execution-meta">
            {story.correlationId ? <>相関ID <code>{story.correlationId}</code></> : "手動起票"} ・ {formatTime(story.updatedAt)} 更新
          </p>
          {tasks.length > 0 ? (
            <ul className="work-task-rows">{tasks.map((task) => <TaskRow key={task.id} projectId={projectId} item={{ kind: "task", task, story: { id: story.id, title: story.title, outcomeId: story.outcomeId } }} backState={backState} withContext={false} names={names} />)}</ul>
          ) : (
            <p className="unset">{taskCount === 0 ? "Taskはまだありません" : "条件に一致するTaskはありません"}</p>
          )}
        </div>
      </details>
      {plan && isManualOpenStory(story) && (
        <div className="action-row">
          <LinkButton variant="secondary" size="sm" to={taskCreatePath(story.projectId, story.id)}>このStoryにTaskを追加<span className="visually-hidden">（{story.title}）</span></LinkButton>
          <LinkButton variant="secondary" size="sm" to={storyEditPath(story.projectId, story.id)}>Storyを編集<span className="visually-hidden">（{story.title}）</span></LinkButton>
        </div>
      )}
    </article>
  );
};

/** 検索語の入力。Enterか「検索」で確定し、入力途中は問い合わせない。 */
const SearchField = ({ q, onSubmit }: { q: string; onSubmit: (q: string) => void }) => {
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(draft.trim()); };
  return (
    <form className="work-search" role="search" onSubmit={submit}>
      <Field label="検索" description="Story・Taskの題名、受入条件・説明、差戻し理由（空白区切りですべてを含む）">
        <TextInput type="search" value={draft} maxLength={maximumWorkQueryLength} onChange={(event) => setDraft(event.target.value)} />
      </Field>
      <Button type="submit" variant="secondary">検索</Button>
    </form>
  );
};

/** 進捗。範囲（Outcome・Story）の受入済みTaskを分子、取消を除くTaskを分母とし、検索・状態の絞り込みでは変えない。 */
const ScopeSummary = ({ page, query, names, workspaceId }: { page: WorkPage; query: WorkQuery; names: OutcomeNames; workspaceId: string | null }) => {
  const { scope } = page;
  const percent = progressPercent(scope);
  const denominator = progressDenominator(scope);
  const outcome = names.state === "ready" ? names.outcomes.find((item) => item.id === query.outcome) : undefined;
  const heading = query.story
    ? "選択したStory"
    : query.outcome === allOutcomes ? "すべてのStory・Task"
    : query.outcome === unsetOutcome ? "Outcome未設定のStory・Task"
    : outcome && workspaceId ? <Link to={workspaceOutcomePath(workspaceId, outcome.intentId, outcome.id)}>{outcome.title}</Link>
    : outcomeLabel(query.outcome, names);
  return (
    <section className="work-summary" aria-labelledby="work-summary-heading">
      <h3 id="work-summary-heading">{heading}</h3>
      {denominator > 0 ? (
        <>
          <p><strong>Task進捗 {percent}%</strong> ・ 受入済み {scope.accepted} / 対象{denominator}件{scope.canceled > 0 && <> ・ 取消 {scope.canceled}件は対象外</>}</p>
          <progress max={denominator} value={scope.accepted} aria-label={`Task進捗 受入済み${scope.accepted}件、対象${denominator}件`} />
        </>
      ) : (
        <p className="unset">{scope.tasks === 0 ? "Taskがまだ起票されていないため、進捗率は算出できません。" : "対象のTaskがすべて取消のため、進捗率は算出できません。"}</p>
      )}
      <p className="section-note">進捗は検索・Taskの状態で絞っても変わりません。Outcomeの達成度ではなく、Agentの稼働も示しません。</p>
    </section>
  );
};

/**
 * Project詳細の「開発詳細」。Outcomeを選ぶ前に、Project内の全Story・Taskと、Outcome未設定・Storyに属さないTaskを同じ場所で探す。
 * 検索・絞り込み・ページ取得はserverが行い、条件とページはURLに保持する（Task詳細から戻っても同じ一覧へ戻る）。
 */
export const WorkSection = ({ projectId, workspaceId }: { projectId: string; workspaceId: string | null }) => {
  const planAccess = useProjectOperationState(projectId, "execution.plan").access;
  const plan = planAccess === "allowed";
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = parseWorkQuery(searchParams);
  const apiPath = workApiPath(projectId, query);
  const [reloadCount, setReloadCount] = useState(0);
  const loadKey = `${apiPath}#${reloadCount}`;
  const [state, setState] = useState<{ key: string; page: WorkPage | null; error: string | null } | null>(null);
  const [names, setNames] = useState<OutcomeNames>({ state: workspaceId === null ? "none" : "loading" });
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    request<WorkPage>(apiPath)
      .then((page) => { if (current) setState({ key: loadKey, page, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ key: loadKey, page: null, error: loadFailureMessage(classifyError(reason), notFound) }); });
    return () => { current = false; };
  }, [loadKey]);
  useEffect(() => {
    if (workspaceId === null) { setNames({ state: "none" }); return; }
    let current = true;
    setNames({ state: "loading" });
    loadWorkspaceOutcomes(workspaceId)
      .then((outcomes) => { if (current) setNames({ state: "ready", outcomes }); })
      .catch(() => { if (current) setNames({ state: "error" }); });
    return () => { current = false; };
  }, [workspaceId]);
  const loaded = state?.key === loadKey ? state : null;
  const page = loaded?.page ?? null;
  // 存在しない大きなpageはserverが最終ページへ寄せる。URLも実際のページへ揃え、戻る操作で同じ位置へ戻れるようにする。
  useEffect(() => {
    if (page && page.page !== query.page) navigate({ search: workSearch(searchParams, { page: page.page }) }, { replace: true });
  }, [page?.page]);
  const apply = (patch: Partial<WorkQuery>) => navigate({ search: workSearch(searchParams, patch) });
  const reload = () => { setState(null); setReloadCount((count) => count + 1); };
  const backState = workBackState(projectId, workSearch(searchParams, {}));
  const filtered = hasWorkCondition(query);
  const outcomeOptions = names.state === "ready" ? names.outcomes : [];
  const unknownOutcome = query.outcome !== allOutcomes && query.outcome !== unsetOutcome && !outcomeOptions.some((outcome) => outcome.id === query.outcome);
  const unit = query.mode === "stories" ? "Story" : "Task";
  const empty = page !== null && page.scope.stories === 0 && page.scope.tasks === 0 && !filtered;
  const goToPage = (next: number) => { apply({ page: next }); resultRef.current?.scrollIntoView({ block: "start" }); };
  return (
    <section className="detail-section" aria-labelledby="work-heading">
      <h2 id="work-heading">Story・Task</h2>
      {plan && (
        <div className="action-row">
          <LinkButton to={storyCreatePath(projectId)}>Storyを起票</LinkButton>
          <LinkButton variant="secondary" to={taskCreatePath(projectId)}>Taskを起票</LinkButton>
        </div>
      )}
      {names.state === "error" && <p role="alert" className="error-title">Outcomeの名称を取得できませんでした。Outcomeは「名称を取得できません」と表示します。</p>}
      <div className="work-filter">
        <Field label="Outcome" layout="inline">
          <Select size="sm" value={query.outcome} onChange={(event) => apply({ outcome: event.target.value, story: null })}>
            <option value={allOutcomes}>すべてのOutcome</option>
            {outcomeOptions.map((outcome) => <option key={outcome.id} value={outcome.id}>{outcome.title}</option>)}
            {unknownOutcome && <option value={query.outcome}>{outcomeLabel(query.outcome, names)}</option>}
            <option value={unsetOutcome}>Outcome未設定</option>
          </Select>
        </Field>
        <Field label="Taskの状態" layout="inline">
          <Select size="sm" value={query.status} onChange={(event) => apply({ status: event.target.value as WorkStatus })}>
            {workStatuses.map((status) => <option key={status} value={status}>{workStatusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="表示" layout="inline">
          <Select size="sm" value={query.mode} onChange={(event) => apply({ mode: event.target.value as WorkMode })}>
            {workModes.map((mode) => <option key={mode} value={mode}>{workModeLabels[mode]}</option>)}
          </Select>
        </Field>
      </div>
      <SearchField q={query.q} onSubmit={(q) => apply({ q })} />
      {query.story && <p className="section-note">Storyを1件に絞っています。<Button variant="text" onClick={() => apply({ story: null })}>Storyの絞り込みを解除</Button></p>}
      {page && <ScopeSummary page={page} query={query} names={names} workspaceId={workspaceId} />}
      <div ref={resultRef} className="work-result-bar" aria-live="polite">
        {page && (
          <span>
            {filtered ? "条件に一致" : "すべて"}: {page.matched.stories} Story・{page.matched.tasks} Task
            {page.range.total > 0 && <> ・ 表示 {unit} {page.range.from}〜{page.range.to} / {page.range.total}件</>}
          </span>
        )}
        {filtered && <Button variant="secondary" size="sm" onClick={() => navigate({ search: clearedWorkSearch(searchParams) })}>条件を解除</Button>}
      </div>
      {loaded === null ? <Loading /> : loaded.error || !page ? (
        <div>
          <ErrorState message={`Story・Taskの読み込みに失敗しました: ${loaded.error}。件数と進捗は表示していません。`} />
          <div className="action-row"><Button variant="secondary" onClick={reload}>再試行</Button></div>
        </div>
      ) : empty ? (
        <p className="unset">{storyEmptyMessage(planAccess)}</p>
      ) : page.range.total === 0 ? (
        <p className="unset">条件に一致する{unit}はありません。条件を変えるか、解除してください。</p>
      ) : (
        <>
          {query.mode === "tasks" ? (
            <ul className="work-task-rows work-task-list">
              {page.items.map((item) => item.kind === "task" && <TaskRow key={item.task.id} projectId={projectId} item={item} backState={backState} withContext names={names} />)}
            </ul>
          ) : (
            <StoryModeList projectId={projectId} items={page.items} plan={plan} openStory={query.story} backState={backState} names={names} />
          )}
          {page.totalPages > 1 && (
            <nav className="work-pager" aria-label="ページ">
              <Button variant="secondary" size="sm" disabled={page.page <= 1} onClick={() => goToPage(page.page - 1)}>前のページ</Button>
              <span aria-live="polite">{page.page} / {page.totalPages} ページ</span>
              <Button variant="secondary" size="sm" disabled={page.page >= page.totalPages} onClick={() => goToPage(page.page + 1)}>次のページ</Button>
            </nav>
          )}
        </>
      )}
      <RecentChanges projectId={projectId} />
    </section>
  );
};

/** Story表示。Storyに続けて、Storyに属さないTaskを1つのまとまりとして出す。 */
const StoryModeList = ({ projectId, items, plan, openStory, backState, names }: { projectId: string; items: WorkItem[]; plan: boolean; openStory: string | null; backState: ReturnType<typeof workBackState>; names: OutcomeNames }) => {
  const unassigned = items.filter((item): item is WorkTaskItem => item.kind === "task");
  return (
    <>
      {items.map((item) => item.kind === "story" && <StoryItem key={item.story.id} projectId={projectId} item={item} plan={plan} defaultOpen={openStory === item.story.id} backState={backState} names={names} />)}
      {unassigned.length > 0 && (
        <article className="work-story">
          <h3>Storyに属さないTask</h3>
          <ul className="work-task-rows">{unassigned.map((item) => <TaskRow key={item.task.id} projectId={projectId} item={item} backState={backState} withContext={false} names={names} />)}</ul>
        </article>
      )}
    </>
  );
};
