import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Dialog, Field, Select, TextInput } from "../../components/ui";
import { projectViewPath, workspacePath } from "../../paths";
import { describePrincipal, formatTime } from "../execution";
import { ReferenceItem } from "./ActivitySection";
import {
  activityListReducer,
  activityPath,
  activityRecordSearch,
  activitySourceLabels,
  activityStreamPath,
  activityStreamSearch,
  activityStreamTypeGroups,
  activityStreamTypeLabel,
  activityTypeNote,
  clearedActivityStreamSearch,
  groupActivitiesByDate,
  hasActivityStreamFilter,
  initialActivityList,
  isActivityPeriodInvalid,
  maximumSearchLength,
  parseActivityRecord,
  parseActivityStreamFilter,
  workspaceCommonTarget,
  type ActivityDetail,
  type ActivityStreamFilter,
  type ActivityStreamPage,
  type ActivitySummary,
  type ProjectResourceLink,
} from "./activity";

/** 対象の選択肢に出す所属Project（archivedを含む）。 */
export type ActivityTargetProject = { id: string; name: string; archived: boolean };

const notFound = "Workspaceが見つからないか、このWorkspaceを閲覧する権限がありません。";

const targetLabel = (activity: Pick<ActivitySummary, "projectId">, projects: readonly ActivityTargetProject[] | null): string =>
  activity.projectId === null ? "Workspace共通" : (projects?.find(({ id }) => id === activity.projectId)?.name ?? `Project ${activity.projectId.slice(0, 8)}`);

const typeText = (type: string) => activityStreamTypeLabel(type) ?? type;

/** 記録の詳細。何が起きたか・主体・時刻・根拠（本文・参照）・対象へのlinkだけを出し、コメント本文や記録に無い履歴は載せない。 */
const ActivityDetailBody = ({ workspaceId, record, projects, resources, onOpen }: {
  workspaceId: string;
  record: NonNullable<ReturnType<typeof parseActivityRecord>>;
  projects: readonly ActivityTargetProject[] | null;
  resources: readonly ProjectResourceLink[] | null;
  onOpen: (activity: Pick<ActivitySummary, "id" | "projectId">) => void;
}) => {
  const [state, setState] = useState<{ key: string; detail: ActivityDetail | null; error: string | null } | null>(null);
  const path = activityPath(record.scope, record.id);
  useEffect(() => {
    let current = true;
    request<ActivityDetail>(path)
      .then((detail) => { if (current) setState({ key: path, detail, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ key: path, detail: null, error: loadFailureMessage(classifyError(reason), "この記録が見つかりません。") }); });
    return () => { current = false; };
  }, [path]);
  const loaded = state?.key === path ? state : null;
  if (!loaded) return <Loading />;
  if (loaded.error || !loaded.detail) return <ErrorState message={`記録を読み込めませんでした: ${loaded.error}`} />;
  const { activity, corrections } = loaded.detail;
  const summary: ActivitySummary = { ...activity, hasBody: activity.body !== null };
  const note = activityTypeNote(activity.type);
  return (
    <div className="activity-detail">
      <p className="activity-detail-summary">{activity.summary}</p>
      {note && <p className="section-note">{note}</p>}
      <dl className="intent-facts">
        <dt>種別</dt><dd>{typeText(activity.type)} <code>{activity.type}</code> <span className="status-badge muted">{activitySourceLabels[activity.source]}</span></dd>
        <dt>主体</dt><dd>{describePrincipal(activity.principalId)}（{activity.role}）</dd>
        <dt>時刻</dt><dd>{formatTime(activity.occurredAt)}</dd>
        <dt>対象</dt>
        <dd>
          {activity.projectId === null
            ? <Link to={workspacePath(workspaceId, "direction")}>Workspace共通（方向）</Link>
            : <Link to={projectViewPath(activity.projectId, "overview")}>{targetLabel(activity, projects)}</Link>}
        </dd>
      </dl>
      <h3>根拠・参照</h3>
      {activity.body ? <p className="pre-wrap">{activity.body}</p> : <p className="unset">本文は記録されていません</p>}
      {activity.refs.length > 0
        ? <ul className="activity-refs" aria-label="参照">{activity.refs.map((reference, index) => <ReferenceItem key={index} scope={record.scope} activity={summary} reference={reference} resources={resources} />)}</ul>
        : <p className="unset">参照はありません</p>}
      {activity.correctsActivityId && (
        <p className="section-note">
          Activity <Button variant="text" onClick={() => onOpen({ id: activity.correctsActivityId!, projectId: activity.projectId })}>{activity.correctsActivityId.slice(0, 8)}</Button> の訂正です。
        </p>
      )}
      {corrections.length > 0 && (
        <p className="section-note">
          訂正: {corrections.map((correction) => (
            <Button key={correction.id} variant="text" onClick={() => onOpen(correction)}>{correction.summary}（#{correction.cursor}）</Button>
          ))}
        </p>
      )}
    </div>
  );
};

/** 検索語。入力中はURLを変えず、送信（Enter・検索）で条件にする。 */
const SearchField = ({ q, onSubmit }: { q: string; onSubmit: (q: string) => void }) => {
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(draft.trim()); };
  return (
    <form className="activity-search" role="search" onSubmit={submit}>
      <Field label="検索" description="題名・本文・種別・主体の部分一致">
        <TextInput type="search" value={draft} maxLength={maximumSearchLength} onChange={(event) => setDraft(event.target.value)} />
      </Field>
      <Button type="submit" variant="secondary">検索</Button>
    </form>
  );
};

/**
 * Workspaceの記録。Workspace共通と所属全Projectの業務Activityを新しい順・日付ごとに横断して表示する。
 * 条件（対象・種別・期間・検索）と開いている詳細はURLのqueryに持ち、詳細を閉じると同じ条件の一覧へ戻る。
 * `projects` / `resources`がnullなら取得に失敗しており、Project名はIDの短縮で、参照先はIDだけで表示する（登録が外れたとは断定しない）。
 */
export const WorkspaceActivityStream = ({ workspaceId, projects, resources }: { workspaceId: string; projects: readonly ActivityTargetProject[] | null; resources: readonly ProjectResourceLink[] | null }) => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const filter = parseActivityStreamFilter(searchParams);
  const record = parseActivityRecord(searchParams, workspaceId);
  const invalidPeriod = isActivityPeriodInvalid(filter);
  const filterKey = `${workspaceId}#${JSON.stringify(filter)}`;
  const [list, dispatch] = useReducer(activityListReducer, filterKey, initialActivityList);
  const { activities, nextCursor, matchedCount, error, moreError, pending, reachedEnd } = list.key === filterKey ? list : initialActivityList(filterKey);
  const generationRef = useRef(0);
  useEffect(() => {
    const generation = ++generationRef.current;
    dispatch({ kind: "reset", key: filterKey, generation });
    if (invalidPeriod) return;
    request<ActivityStreamPage>(activityStreamPath(workspaceId, filter))
      .then((page) => dispatch({ kind: "loaded", generation, page }))
      .catch((reason: unknown) => dispatch({ kind: "failed", generation, message: loadFailureMessage(classifyError(reason), notFound) }));
  }, [filterKey]);
  const endNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (reachedEnd) endNote.current?.focus(); }, [reachedEnd]);
  const loadMore = async () => {
    if (nextCursor === null || pending) return;
    const { generation } = list;
    dispatch({ kind: "moreStarted", generation });
    try {
      const page = await request<ActivityStreamPage>(activityStreamPath(workspaceId, filter, { before: String(nextCursor) }));
      dispatch({ kind: "moreLoaded", generation, page });
    } catch (reason) {
      dispatch({ kind: "moreFailed", generation, message: `古い記録を読み込めませんでした: ${loadFailureMessage(classifyError(reason), notFound)}` });
    }
  };
  const apply = (patch: Partial<ActivityStreamFilter>) => navigate({ search: activityStreamSearch(searchParams, patch) });
  const open = (target: Pick<ActivitySummary, "id" | "projectId"> | null) => navigate({ search: activityRecordSearch(searchParams, target) });
  const filtered = hasActivityStreamFilter(filter);
  const knownTarget = filter.target === null || filter.target === workspaceCommonTarget || projects?.some(({ id }) => id === filter.target) === true;
  const knownType = filter.type === null || activityStreamTypeLabel(filter.type) !== null;
  return (
    <section className="detail-section" aria-labelledby="activity-heading">
      <h2 id="activity-heading">Activity</h2>
      <p className="section-note">Workspace共通と所属全Projectの業務上の活動を、新しい順に表示します。コメント・内部通信・Claimの更新は含みません。成果物の本文はRepository・Docs側が正本で、ここでは参照先だけを表示します。</p>
      <div className="activity-filter">
        <Field label="対象" layout="inline">
          <Select size="sm" value={filter.target ?? ""} onChange={(event) => apply({ target: event.target.value || null })}>
            <option value="">すべての記録</option>
            <option value={workspaceCommonTarget}>Workspace共通</option>
            {projects && projects.length > 0 && (
              <optgroup label="Project">
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.archived ? "（アーカイブ済み）" : ""}</option>)}
              </optgroup>
            )}
            {!knownTarget && <option value={filter.target!}>Project {filter.target!.slice(0, 8)}</option>}
          </Select>
        </Field>
        <Field label="種別" layout="inline">
          <Select size="sm" value={filter.type ?? ""} onChange={(event) => apply({ type: event.target.value || null })}>
            <option value="">すべて</option>
            {activityStreamTypeGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.types.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
              </optgroup>
            ))}
            {!knownType && <optgroup label="記録"><option value={filter.type!}>{filter.type}</option></optgroup>}
          </Select>
        </Field>
        <Field label="開始日" layout="inline"><TextInput type="date" size="sm" value={filter.from ?? ""} max={filter.to ?? undefined} onChange={(event) => apply({ from: event.target.value || null })} /></Field>
        <Field label="終了日" layout="inline"><TextInput type="date" size="sm" value={filter.to ?? ""} min={filter.from ?? undefined} onChange={(event) => apply({ to: event.target.value || null })} /></Field>
      </div>
      <SearchField q={filter.q} onSubmit={(q) => apply({ q })} />
      {projects === null && <p className="section-note" role="status">Projectの一覧を読み込めませんでした。対象はWorkspace共通とすべての記録だけを選べます。</p>}
      {invalidPeriod && <p role="alert" className="error-title">開始日は終了日以前にしてください。</p>}
      <div className="activity-result-bar" aria-live="polite">
        {matchedCount !== null && <span>{filtered ? "条件に一致する記録" : "すべての記録"}: {matchedCount}件</span>}
        {filtered && <Button variant="secondary" size="sm" onClick={() => navigate({ search: clearedActivityStreamSearch(searchParams) })}>条件を解除</Button>}
      </div>
      {invalidPeriod ? null : error ? (
        <ErrorState message={`Activityの読み込みに失敗しました: ${error}`} />
      ) : activities === null ? (
        <Loading />
      ) : activities.length === 0 ? (
        <p className="unset">{filtered ? "条件に一致する記録はありません。条件を変えるか、解除してください。" : "Activityはまだありません"}</p>
      ) : (
        <>
          {groupActivitiesByDate(activities).map((group) => (
            <section key={group.date} className="activity-day" aria-label={group.label}>
              <h3>{group.label}</h3>
              <ul className="grant-list change-list">
                {group.activities.map((activity) => (
                  <li key={activity.id}>
                    <Link
                      className="activity-title"
                      to={{ search: activityRecordSearch(searchParams, activity) }}
                      onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); open(activity); } }}
                    >{activity.summary}</Link>
                    <small>
                      {typeText(activity.type)} ・ {targetLabel(activity, projects)} ・ {describePrincipal(activity.principalId)}（{activity.role}） ・ {formatTime(activity.occurredAt)}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {moreError && <p role="alert" className="error-title">{moreError}</p>}
          {reachedEnd && <p ref={endNote} tabIndex={-1} className="unset">これより古い記録はありません</p>}
          {nextCursor !== null && (
            <div className="action-row">
              <Button variant="secondary" pending={pending} onClick={() => void loadMore()}>{pending ? "読み込み中..." : "さらに古い記録"}</Button>
            </div>
          )}
        </>
      )}
      <Dialog open={record !== null} onClose={() => open(null)} title="記録の詳細">
        {record && <ActivityDetailBody workspaceId={workspaceId} record={record} projects={projects} resources={resources} onOpen={open} />}
      </Dialog>
    </section>
  );
};
