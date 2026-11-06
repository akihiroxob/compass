import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Dialog, Field, Select, TextInput } from "../../components/ui";
import { projectViewPath, taskPath, workspaceOutcomePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { describePrincipal, formatTime, loadOutcomeRef } from "../execution";
import {
  changeTime,
  changesOfPublication,
  clearedReleaseSearch,
  commitUrl,
  countByPublication,
  developmentLabels,
  evidenceKindLabels,
  filterReleaseChanges,
  hasReleaseFilter,
  isHttpUri,
  maximumReleaseSearchLength,
  paginateReleaseChanges,
  parseReleaseChange,
  parseReleaseFilter,
  publicationEffectNote,
  publicationNote,
  publicationsOfChange,
  publicationSourceNote,
  publicationStatusLabels,
  publicationStatusTones,
  relationOf,
  releasePageSize,
  releaseSearch,
  summaryExcerpt,
  releasesPath,
  shortSha,
  type PublicationFilter,
  type PublicationRecordView,
  type ReleaseChange,
  type ReleaseHistory,
} from "./release";

export type ReleaseProject = { id: string; workspaceId: string; repositories: readonly { id: string; name: string; url: string }[] };

const notFound = "Projectが見つからないか、このProjectを閲覧する権限がありません。";

const PublicationBadge = ({ change }: { change: ReleaseChange }) => (
  <span className={statusBadgeClass(publicationStatusTones[change.publication.status])}>公開: {publicationStatusLabels[change.publication.status]}</span>
);
const DevelopmentBadge = ({ change }: { change: ReleaseChange }) => (
  <span className={statusBadgeClass(change.development.status === "accepted" ? "done" : "waiting")}>開発: {developmentLabels[change.development.status]}</span>
);

const SearchField = ({ q, onSubmit }: { q: string; onSubmit: (q: string) => void }) => {
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(draft.trim()); };
  return (
    <form className="release-search" role="search" onSubmit={submit}>
      <Field label="検索" description="題名・Story・PR番号・Commit・公開先・受入者の部分一致">
        <TextInput type="search" value={draft} maxLength={maximumReleaseSearchLength} onChange={(event) => setDraft(event.target.value)} />
      </Field>
      <Button type="submit" variant="secondary">検索</Button>
    </form>
  );
};

const RepositoryName = ({ project, repositoryId }: { project: ReleaseProject; repositoryId: string }) =>
  <>{project.repositories.find(({ id }) => id === repositoryId)?.name ?? `Repository ${repositoryId.slice(0, 8)}`}</>;

const Commit = ({ project, repositoryId, sha }: { project: ReleaseProject; repositoryId: string; sha: string }) => {
  const url = commitUrl(project.repositories.find(({ id }) => id === repositoryId)?.url, sha);
  return <code>{url ? <a href={url} target="_blank" rel="noreferrer">{shortSha(sha)}<span className="visually-hidden">（Commitを新しいタブで開く）</span></a> : shortSha(sha)}</code>;
};

const Evidence = ({ evidence }: { evidence: PublicationRecordView["evidence"] }) => (
  <ul className="release-refs" aria-label="公開の根拠">
    {evidence.map((item, index) => (
      <li key={index}>
        {evidenceKindLabels[item.kind]}: {isHttpUri(item.uri)
          ? <a href={item.uri} target="_blank" rel="noreferrer">{item.uri}<span className="visually-hidden">（新しいタブで開く）</span></a>
          : <span>{item.uri}</span>}
      </li>
    ))}
  </ul>
);

/** 原記録（公開確認）1件。この記録に関係する他のTaskも示し、複数Taskを含む公開を辿れるようにする。 */
const PublicationRecord = ({ project, record, change, history, onOpen }: {
  project: ReleaseProject;
  record: PublicationRecordView;
  change: ReleaseChange;
  history: ReleaseHistory;
  onOpen: (taskId: string) => void;
}) => {
  const relation = relationOf(record, change);
  const others = changesOfPublication(record, history.changes).filter(({ task }) => task.id !== change.task.id);
  return (
    <li className="release-record">
      <p>
        <strong>{record.target}</strong> ・ <RepositoryName project={project} repositoryId={record.repositoryId} /> @ <Commit project={project} repositoryId={record.repositoryId} sha={record.revision} />
        {record.current ? <> <span className="status-badge tone-progress">公開先の最新</span></> : <> <span className="status-badge muted">過去の記録</span></>}
      </p>
      <p className="section-note">
        確認 {formatTime(record.observedAt)}（受付 {formatTime(record.receivedAt)}） ・ {describePrincipal(record.principalId)}{record.method ? ` ・ 方式 ${record.method}` : ""}
      </p>
      <p>
        この変更のCommit: {relation === "included" ? "含まれています" : relation === "not_included" ? "含まれていません" : "判定していません"}
        {record.targetUrl && <> ・ <a href={record.targetUrl} target="_blank" rel="noreferrer">公開先URL<span className="visually-hidden">（新しいタブで開く）</span></a></>}
      </p>
      <Evidence evidence={record.evidence} />
      {others.length > 0 && (
        <p className="section-note">
          同じ記録に関係する他のTask（{others.length}件）:{" "}
          {others.map((other) => (
            <Button key={other.task.id} variant="text" onClick={() => onOpen(other.task.id)}>{other.task.title}</Button>
          ))}
        </p>
      )}
    </li>
  );
};

type OutcomeState = { key: string; outcome: { id: string; intentId: string; title: string } | null; error: string | null };

/** 変更の詳細。受入と公開を別の項目で示し、関連するOutcome・Story・Task・PR・Commit・原記録へ辿る。 */
const ReleaseDetail = ({ project, change, history, onOpen }: { project: ReleaseProject; change: ReleaseChange; history: ReleaseHistory; onOpen: (taskId: string) => void }) => {
  const outcomeId = change.story?.outcomeId ?? null;
  const key = `${project.workspaceId}/${outcomeId ?? ""}`;
  const [outcomeState, setOutcomeState] = useState<OutcomeState | null>(null);
  useEffect(() => {
    if (outcomeId === null) return;
    let current = true;
    loadOutcomeRef(project.workspaceId, outcomeId)
      .then((outcome) => { if (current) setOutcomeState({ key, outcome, error: null }); })
      .catch((reason: unknown) => { if (current) setOutcomeState({ key, outcome: null, error: loadFailureMessage(classifyError(reason), "Outcomeを閲覧できません。") }); });
    return () => { current = false; };
  }, [key]);
  const outcome = outcomeState?.key === key ? outcomeState : null;
  const records = publicationsOfChange(change, history.publications);
  const { publication, development, pullRequest } = change;
  return (
    <div className="release-detail">
      <p className="release-detail-summary">{change.task.title}</p>
      <p><DevelopmentBadge change={change} /> <PublicationBadge change={change} /></p>
      <h3>変更の要約</h3>
      {change.summary === null
        ? <p className="unset">完了時の実装メモが記録されていないため、変更の要約はありません。題名とTaskの記録から確認してください。</p>
        : (
          <>
            <p className="release-summary-body">{change.summary.body}{change.summary.truncated ? "…" : ""}</p>
            <small>
              完了時の実装メモ ・ {change.summary.author ? `${change.summary.author} ・ ` : ""}{formatTime(change.summary.recordedAt)}
              {change.summary.truncated ? "（一部のみ表示）" : ""} ・ <Link to={taskPath(project.id, change.task.id)}>Taskのコメントで全文を見る</Link>
            </small>
          </>
        )}
      <h3>開発の受入</h3>
      <dl className="intent-facts">
        <dt>状態</dt><dd>{developmentLabels[development.status]}（Task: {change.task.status}）</dd>
        <dt>受入日時</dt><dd>{development.acceptedAt === null ? <span className="unset">記録されていません</span> : formatTime(development.acceptedAt)}</dd>
        <dt>受入者</dt><dd>{development.acceptedBy === null ? <span className="unset">記録されていません</span> : describePrincipal(development.acceptedBy)}</dd>
      </dl>
      <h3>公開の確認</h3>
      <p>{publicationNote(publication)}</p>
      <dl className="intent-facts">
        <dt>公開日時</dt><dd>{publication.publishedAt === null ? <span className="unset">{publication.status === "published" ? "記録されていません" : "公開を確認できていません"}</span> : formatTime(publication.publishedAt)}</dd>
      </dl>
      {publication.targets.length > 0 && (
        <ul className="release-refs" aria-label="公開先ごとの状況">
          {publication.targets.map((target) => (
            <li key={`${target.target}/${target.repositoryId}`}>
              {target.target}（<RepositoryName project={project} repositoryId={target.repositoryId} />）: {publicationStatusLabels[target.status]}
              {target.publishedAt !== null && <>（{formatTime(target.publishedAt)}）</>}
            </li>
          ))}
        </ul>
      )}
      <p className="section-note">{publicationEffectNote}</p>
      <h3>関連する目標・仕事</h3>
      <dl className="intent-facts">
        <dt>Outcome</dt>
        <dd>
          {outcomeId === null ? <span className="unset">Outcomeを参照しない変更です</span>
            : !outcome ? <span role="status">読み込み中...</span>
            : outcome.error ? <span role="alert" className="error-title">Outcomeを読み込めませんでした: {outcome.error}</span>
            : outcome.outcome ? <Link to={workspaceOutcomePath(project.workspaceId, outcome.outcome.intentId, outcome.outcome.id)}>{outcome.outcome.title}</Link>
            : <span className="unset">Outcome {outcomeId.slice(0, 8)}（Workspaceに見つかりません）</span>}
        </dd>
        <dt>Story</dt><dd>{change.story ? change.story.title : <span className="unset">Storyに属していません</span>}</dd>
        <dt>Task</dt><dd><Link to={taskPath(project.id, change.task.id)}>{change.task.title}</Link></dd>
        <dt>PR</dt>
        <dd>
          {pullRequest
            ? <><a href={pullRequest.url} target="_blank" rel="noreferrer">{pullRequest.repository}#{pullRequest.number}<span className="visually-hidden">（PRを新しいタブで開く）</span></a>（{pullRequest.state}）</>
            : <span className="unset">PRは登録されていません</span>}
        </dd>
        <dt>対象Commit</dt>
        <dd>
          {change.revisions.length === 0 ? <span className="unset">対象Commitがありません</span> : (
            <ul className="release-refs" aria-label="対象Commit">
              {change.revisions.map((revision) => (
                <li key={`${revision.repositoryId}/${revision.commitSha}`}>
                  <RepositoryName project={project} repositoryId={revision.repositoryId} /> <Commit project={project} repositoryId={revision.repositoryId} sha={revision.commitSha} />
                  （{revision.source === "pull_request_merge" ? "PRのmerge" : "受入成果物"}）
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      <h3>公開の原記録</h3>
      {records.length === 0
        ? <p className="unset">この変更に関係する公開記録はありません</p>
        : <ul className="release-records">{records.map((record) => <PublicationRecord key={record.id} project={project} record={record} change={change} history={history} onOpen={onOpen} />)}</ul>}
    </div>
  );
};

/**
 * Projectのリリース履歴。変更（Task・PR・対象Commit）を新しい順に、開発の受入と公開の状況を別の項目として表示する。
 * 公開状況はAPIが公開記録だけから導出した値で、受入・mergeから推測しない。条件・ページ・開いている詳細はURLのqueryに持つ。
 */
export const ReleaseHistorySection = ({ project }: { project: ReleaseProject }) => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<{ key: string; history: ReleaseHistory | null; error: string | null } | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const loadKey = `${project.id}#${reloadCount}`;
  useEffect(() => {
    let current = true;
    request<ReleaseHistory>(releasesPath(project.id))
      .then((history) => { if (current) setState({ key: loadKey, history, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ key: loadKey, history: null, error: loadFailureMessage(classifyError(reason), notFound) }); });
    return () => { current = false; };
  }, [loadKey]);
  const loaded = state?.key === loadKey ? state : null;
  const filter = parseReleaseFilter(searchParams);
  const changeId = parseReleaseChange(searchParams);
  const apply = (patch: Parameters<typeof releaseSearch>[1]) => navigate({ search: releaseSearch(searchParams, patch) });
  const reload = () => { setState(null); setReloadCount((count) => count + 1); };
  const history = loaded?.history ?? null;
  const filtered = hasReleaseFilter(filter);
  const matched = history ? filterReleaseChanges(history.changes, filter) : [];
  const page = paginateReleaseChanges(matched, filter.page);
  const counts = history ? countByPublication(history.changes) : null;
  const sourceNote = history ? publicationSourceNote(history.publicationSource) : null;
  const opened = history && changeId ? history.changes.find(({ task }) => task.id === changeId) ?? null : null;
  return (
    <section className="detail-section" aria-labelledby="release-heading">
      <h2 id="release-heading">リリース履歴</h2>
      <p className="section-note">開発の受入と公開の確認は別の記録です。公開状況は公開記録だけから判定し、PRのmergeやTaskの受入を公開済みとしません。{publicationEffectNote}</p>
      <div className="action-row">
        <Button variant="secondary" size="sm" onClick={reload} pending={loaded === null}>再読込</Button>
      </div>
      {sourceNote && <p className="section-note release-source-note" role="status">{sourceNote}</p>}
      <div className="release-filter">
        <Field label="公開状況" layout="inline">
          <Select size="sm" value={filter.publication} onChange={(event) => apply({ publication: event.target.value as PublicationFilter })}>
            <option value="all">すべて{counts ? `（${history!.changes.length}）` : ""}</option>
            <option value="published">公開済み{counts ? `（${counts.published}）` : ""}</option>
            <option value="not_published">未公開{counts ? `（${counts.not_published}）` : ""}</option>
            <option value="unconfirmed">確認できず{counts ? `（${counts.unconfirmed}）` : ""}</option>
          </Select>
        </Field>
      </div>
      <SearchField q={filter.q} onSubmit={(q) => apply({ q })} />
      <div className="release-result-bar" aria-live="polite">
        {history && <span>{filtered ? "条件に一致する変更" : "すべての変更"}: {page.total}件</span>}
        {filtered && <Button variant="secondary" size="sm" onClick={() => navigate({ search: clearedReleaseSearch(searchParams) })}>条件を解除</Button>}
      </div>
      {loaded === null ? <Loading /> : loaded.error || !history ? (
        <div>
          <ErrorState message={`リリース履歴を読み込めませんでした: ${loaded.error}。公開状況は表示していません。`} />
          <div className="action-row"><Button variant="secondary" onClick={reload}>再試行</Button></div>
        </div>
      ) : history.changes.length === 0 ? (
        <p className="unset">リリース履歴の対象になる変更はまだありません。PRを登録したTaskか、受入成果物のあるTaskが対象です。</p>
      ) : page.total === 0 ? (
        <p className="unset">条件に一致する変更はありません。条件を変えるか、解除してください。</p>
      ) : (
        <>
          <ul className="grant-list change-list">
            {page.items.map((change) => (
              <li key={change.task.id}>
                <Link
                  className="release-title"
                  to={{ search: releaseSearch(searchParams, { change: change.task.id }) }}
                  onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); apply({ change: change.task.id }); } }}
                >{change.task.title}</Link>
                {summaryExcerpt(change) !== null
                  ? <p className="release-summary-excerpt">{summaryExcerpt(change)}</p>
                  : <p className="release-summary-excerpt unset">変更の要約は記録されていません</p>}
                <small>
                  <DevelopmentBadge change={change} /> <PublicationBadge change={change} />
                  {" "}{change.story ? `${change.story.title} ・ ` : ""}{change.pullRequest ? `PR #${change.pullRequest.number} ・ ` : ""}
                  {change.publication.publishedAt !== null ? `公開 ${formatTime(change.publication.publishedAt)} ・ ` : ""}
                  {change.development.status === "accepted" ? "受入" : "更新"} {formatTime(changeTime(change))}
                </small>
              </li>
            ))}
          </ul>
          {page.pageCount > 1 && (
            <nav className="release-pager" aria-label="ページ">
              <Button variant="secondary" size="sm" disabled={page.page <= 1} onClick={() => apply({ page: page.page - 1 })}>前のページ</Button>
              <span aria-live="polite">{page.page} / {page.pageCount} ページ（{releasePageRange(page.page, page.total)}件目）</span>
              <Button variant="secondary" size="sm" disabled={page.page >= page.pageCount} onClick={() => apply({ page: page.page + 1 })}>次のページ</Button>
            </nav>
          )}
        </>
      )}
      <Dialog open={changeId !== null && history !== null} onClose={() => apply({ change: null })} title="リリースの詳細">
        {history && changeId && (opened
          ? <ReleaseDetail project={project} change={opened} history={history} onOpen={(taskId) => apply({ change: taskId })} />
          : <p className="unset">この変更は履歴に見つかりません。<Link to={projectViewPath(project.id, "work")}>開発詳細</Link>でTaskを確認できます。</p>)}
      </Dialog>
    </section>
  );
};

const releasePageRange = (page: number, total: number) => {
  return `${(page - 1) * releasePageSize + 1}〜${Math.min(page * releasePageSize, total)}`;
};
