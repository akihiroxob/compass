import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, type Part } from "../../api";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, Field, Select, TextInput } from "../../components/ui";
import { projectViewPath, workspaceOutcomePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { ConfirmationView, ProblemSummaryView, TaskProgressView } from "./OutcomeOverviewParts";
import {
  conditionsSearch, hasConditions, loadOutcomeOverviews, outcomePageSize, outcomeProblemFilters, problemFilterLabels,
  readConditions, type OutcomeListConditions, type OutcomeOverview, type OutcomeOverviewPage, type OutcomeProblemFilter,
} from "./outcomeOverview";
import { outcomeStatusLabels, type Outcome } from "./outcome";

type ProjectLabel = { id: string; name: string; archived: boolean };
type Loaded = { key: string; page: OutcomeOverviewPage | null; error: string | null };

const outcomeTone = (status: string) => (status === "active" ? "progress" : "muted");

/** 関連Project。名前が分からないときはIDの先頭だけを出し、名前を推測しない。 */
const RelatedProjects = ({ overview, projects }: { overview: OutcomeOverview; projects: ProjectLabel[] | null }) => {
  if (overview.targets.length === 0) return <span className="unset">対象Projectなし</span>;
  return (
    <ul className="outcome-project-list">
      {overview.targets.map((target) => {
        const label = projects?.find(({ id }) => id === target.projectId);
        return (
          <li key={target.projectId}>
            {label ? <Link to={projectViewPath(target.projectId, "overview")}>{label.name}</Link> : <code>{target.projectId.slice(0, 8)}</code>}
            {(target.projectStatus === "archived" || label?.archived) && <> <span className="status-badge muted">アーカイブ済み</span></>}
          </li>
        );
      })}
    </ul>
  );
};

/**
 * Workspaceの固定メニュー「Outcome」の一覧。ビジネス目標をまたぎ、目的・Task進捗・止まっている問題を同じ行（スマートフォンはカード内）で比べる。
 * 検索・目標・問題の有無はURLに保持し、詳細から戻っても同じ条件・ページで開く。検索は表示するOutcomeを選ぶだけで、Task進捗の分母は変えない。
 * Task進捗はOutcomeの達成度ではない（提供状況・効果の確認状況はTask進捗と別に示す）。
 */
export const OutcomeOverviewList = ({ workspaceId, intents, projects }: { workspaceId: string; intents: { id: string; title: string }[]; projects: Part<{ project: { id: string; name: string; status: string } }[]> }) => {
  const [search, setSearch] = useSearchParams();
  const conditions = readConditions(search);
  const key = `${workspaceId}${conditionsSearch(conditions)}`;
  const [state, setState] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState(conditions.q);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setDraft(conditions.q), [conditions.q]);
  useEffect(() => {
    let active = true;
    loadOutcomeOverviews(workspaceId, conditions)
      .then((page) => { if (active) setState({ key, page, error: null }); })
      .catch((reason: unknown) => { if (active) setState({ key, page: null, error: loadFailureMessage(classifyError(reason), "Workspaceが見つかりません。") }); });
    return () => { active = false; };
  }, [key, attempt]);
  const current = state?.key === key ? state : null;
  const labels: ProjectLabel[] | null = projects.ok ? projects.value.map(({ project }) => ({ id: project.id, name: project.name, archived: project.status === "archived" })) : null;
  const change = (next: Partial<OutcomeListConditions>) => setSearch(conditionsSearch({ ...conditions, page: 1, ...next }).slice(1), { replace: false });
  const submit = (event: FormEvent) => { event.preventDefault(); change({ q: draft }); };
  const page = current?.page ?? null;
  const pages = page ? Math.max(1, Math.ceil(page.total / outcomePageSize)) : 1;
  const listSearch = conditionsSearch(conditions);
  return (
    <section className="detail-section outcome-overview" aria-labelledby="outcome-overview-heading">
      <h2 id="outcome-overview-heading">Outcome一覧</h2>
      <p className="section-note">ビジネス目標をまたいで、目的・Task進捗・止まっている問題を比べます。Task進捗は受入済みTaskの割合で、Outcomeの達成度や効果ではありません。</p>
      <form className="outcome-filter" onSubmit={submit} role="search" aria-label="Outcomeの絞り込み">
        <Field label="検索"><TextInput type="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Outcome名・説明・仮説・目標名" /></Field>
        <Field label="ビジネス目標">
          <Select value={conditions.intentId} onChange={(event) => change({ intentId: event.target.value })}>
            <option value="">すべての目標</option>
            {intents.map((intent) => <option key={intent.id} value={intent.id}>{intent.title}</option>)}
          </Select>
        </Field>
        <Field label="問題">
          <Select value={conditions.problem} onChange={(event) => change({ problem: event.target.value as OutcomeProblemFilter })}>
            {outcomeProblemFilters.map((value) => <option key={value} value={value}>{problemFilterLabels[value]}</option>)}
          </Select>
        </Field>
        <div className="outcome-filter-actions">
          <Button type="submit" variant="secondary">検索</Button>
          {hasConditions(conditions) && <Button type="button" variant="secondary" onClick={() => { setDraft(""); setSearch("", { replace: false }); }}>条件を解除</Button>}
        </div>
      </form>
      {!current ? <Loading /> : current.error ? (
        <><ErrorState message={`Outcome一覧の読み込みに失敗しました: ${current.error}`} /><Button variant="secondary" onClick={() => { setState(null); setAttempt((value) => value + 1); }}>再試行</Button></>
      ) : !page ? null : (
        <>
          <p className="outcome-count" role="status">{hasConditions(conditions) ? `条件に一致 ${page.total}件 / Workspace全体 ${page.workspaceTotal}件` : `${page.workspaceTotal}件`}</p>
          {page.workspaceTotal === 0 ? (
            <StateCard><p>Outcomeはまだありません。ビジネス目標の詳細から「Outcomeを追加」します。</p></StateCard>
          ) : page.total === 0 ? (
            <StateCard><p>条件に一致するOutcomeはありません。</p></StateCard>
          ) : (
            <ul className="outcome-rows">
              <li className="outcome-row outcome-row-head" aria-hidden="true"><span>目的</span><span>Task進捗</span><span>止まっている問題</span></li>
              {page.items.map((overview) => (
                <li className="outcome-row" key={overview.outcomeId}>
                  <div className="outcome-cell outcome-purpose">
                    <p className="outcome-intent">{overview.intentTitle || "目標不明"}</p>
                    <h3><Link to={workspaceOutcomePath(workspaceId, overview.intentId, overview.outcomeId)} state={{ listSearch }}>{overview.title}</Link>{" "}
                      {overview.status !== "active" && <span className={statusBadgeClass(outcomeTone(overview.status))}>{outcomeStatusLabels[overview.status as Outcome["status"]] ?? overview.status}</span>}</h3>
                    <p className="outcome-hypothesis">{overview.hypothesis ?? overview.description}</p>
                    <ConfirmationView delivery={overview.delivery} effect={overview.effect} />
                    <RelatedProjects overview={overview} projects={labels} />
                  </div>
                  <div className="outcome-cell"><p className="outcome-cell-label">Task進捗</p>
                    <TaskProgressView progress={overview.progress} />
                    {overview.progress.unplannedProjectCount > 0 && overview.progress.kind === "counted" && <p className="outcome-progress-note">未起票のProject {overview.progress.unplannedProjectCount}件</p>}
                  </div>
                  <div className="outcome-cell"><p className="outcome-cell-label">止まっている問題</p><ProblemSummaryView problems={overview.problems} /></div>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav className="outcome-pager" aria-label="Outcome一覧のページ">
              <Button variant="secondary" disabled={conditions.page <= 1} onClick={() => setSearch(conditionsSearch({ ...conditions, page: conditions.page - 1 }).slice(1))}>前へ</Button>
              <span>{conditions.page} / {pages}ページ</span>
              <Button variant="secondary" disabled={conditions.page >= pages} onClick={() => setSearch(conditionsSearch({ ...conditions, page: conditions.page + 1 }).slice(1))}>次へ</Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
};
