import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, Field, Select, ViewSwitch } from "../../components/ui";
import { ConsultationList } from "./ConsultationList";
import {
  consultationDetailPath,
  consultationFilterLabels,
  consultationFilters,
  describeConsultationScope,
  inboxApiPath,
  inboxOrderNotes,
  inboxPath,
  inboxScopeFilterLabels,
  inboxScopeFilters,
  parseInboxQuery,
  scopeOfConsultation,
  type Consultation,
  type ConsultationFilter,
  type InboxPage,
  type InboxQuery,
} from "./consultation";

/** 絞り込みの選択肢と所属の表示名。閲覧できるProject・Workspace（Membershipのあるもの。archivedを含む）の一覧から作る。 */
type ScopeOption = { id: string; name: string; archived: boolean; workspaceId?: string };
type ScopeOptions = { projects: ScopeOption[]; workspaces: ScopeOption[] };

type Named = { id: string; name: string; workspaceId?: string };
const loadScopeOptions = async (): Promise<ScopeOptions> => {
  const list = async <T extends Named>(path: string, field: "projects" | "workspaces") => {
    const [active, archived] = await Promise.all(["", "?status=archived"].map((query) => request<Record<string, T[]>>(`${path}${query}`)));
    return [...(active?.[field] ?? []).map((item) => ({ ...item, archived: false })), ...(archived?.[field] ?? []).map((item) => ({ ...item, archived: true }))]
      .map(({ id, name, archived, workspaceId }) => ({ id, name, archived, ...(workspaceId === undefined ? {} : { workspaceId }) }));
  };
  const [projects, workspaces] = await Promise.all([list("/api/projects", "projects"), list("/api/workspaces", "workspaces")]);
  return { projects, workspaces };
};

const emptyMessages: Record<ConsultationFilter, string> = {
  waiting_human: "閲覧できるProject・Workspaceに、Humanの判断を待っている相談はありません。",
  waiting_agent: "Agentの応答を待っている相談はありません。",
  resolved: "解決済みの相談はありません。",
  canceled: "取り消した相談はありません。",
  all: "閲覧できるProject・Workspaceに相談はありません。",
};

const workspaceEmptyMessages: Record<ConsultationFilter, string> = {
  ...emptyMessages,
  waiting_human: "このWorkspaceと配下Projectに、Humanの回答を待っている相談はありません。",
  all: "このWorkspaceと配下Projectに相談はありません。",
};

/** 一覧の状態。`key`は取得条件（URLのquery）で、条件が変わった最初のrenderから前の結果を出さない。 */
type ListState = { key: string; consultations: Consultation[]; nextCursor: string | null; error: string | null; loaded: boolean };

/**
 * 横断した判断待ち。自分がMembershipを持つWorkspaceと、その配下Projectの相談を一覧する（serverが認可済みの集合に対して
 * 絞り込み・ページングする）。既定はHumanの判断待ち。
 * 状態・scope・Workspace・Projectで絞り、続きは「さらに表示」で読む。返信・決定は各相談の詳細で行う。
 */
export const ConsultationInboxPage = () => <ConsultationInbox />;

/**
 * Workspaceの「対応待ち」。そのWorkspaceと配下Projectの相談だけを同じ一覧で扱う（`workspaceId`で固定し、Workspaceの選択は出さない）。
 * 既定はHumanが回答しないと進まない相談だけで、回答期限が近い順に並べる。個々の相談の所有・認可はそれぞれのscopeのままで、
 * 一覧は認可済みの相談を集約するだけ。返信・決定は各相談の詳細で行う。
 */
export const WorkspaceWaitingList = ({ workspaceId, basePath }: { workspaceId: string; basePath: string }) => <ConsultationInbox workspaceId={workspaceId} basePath={basePath} />;

const ConsultationInbox = ({ workspaceId, basePath }: { workspaceId?: string; basePath?: string }) => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const fixedWorkspace = workspaceId !== undefined;
  const parsed = parseInboxQuery(searchParams);
  const query: InboxQuery = fixedWorkspace ? { ...parsed, workspaceId } : parsed;
  // 固定したWorkspaceはURLに載せない（画面のpathが決める）。
  const pathFor = (value: InboxQuery) => inboxPath(fixedWorkspace ? { ...value, workspaceId: null } : value, basePath);
  const key = inboxApiPath(query);
  const [state, setState] = useState<ListState | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pending, setPending] = useState<"reload" | "more" | null>(null);
  const [options, setOptions] = useState<ScopeOptions | null>(null);
  const fetchFirst = (): Promise<ListState> =>
    request<InboxPage>(key).then(
      ({ consultations, nextCursor }) => ({ key, consultations, nextCursor, error: null, loaded: true }),
      (reason: unknown) => ({ key, consultations: [], nextCursor: null, error: loadFailureMessage(classifyError(reason), "判断待ちの一覧を読み込めませんでした。"), loaded: true }),
    );
  useEffect(() => {
    let current = true;
    setMoreError(null);
    void fetchFirst().then((next) => { if (current) setState(next); });
    return () => { current = false; };
  }, [key]);
  useEffect(() => {
    let current = true;
    // 所属名と絞り込みの選択肢。読めなくても一覧は出し、名前の代わりにIDの先頭を出す。
    loadScopeOptions().then((value) => { if (current) setOptions(value); }, () => { if (current) setOptions({ projects: [], workspaces: [] }); });
    return () => { current = false; };
  }, []);
  const settled = state?.key === key ? state : null;
  const reload = async () => {
    setPending("reload");
    setMoreError(null);
    setState(await fetchFirst());
    setPending(null);
  };
  const loadMore = async () => {
    if (!settled?.nextCursor) return;
    setPending("more");
    setMoreError(null);
    try {
      const page = await request<InboxPage>(inboxApiPath(query, settled.nextCursor));
      setState((previous) => previous?.key === key
        ? { ...previous, consultations: [...previous.consultations, ...page.consultations.filter(({ id }) => !previous.consultations.some((item) => item.id === id))], nextCursor: page.nextCursor }
        : previous);
    } catch (reason) {
      setMoreError(loadFailureMessage(classifyError(reason), "続きを読み込めませんでした。"));
    } finally {
      setPending(null);
    }
  };
  const change = (patch: Partial<InboxQuery>) => navigate(pathFor({ ...query, ...patch }));
  const names = {
    projects: new Map((options?.projects ?? []).map(({ id, name }) => [id, name])),
    workspaces: new Map((options?.workspaces ?? []).map(({ id, name }) => [id, name])),
  };
  const projectChoices = (options?.projects ?? []).filter((project) => query.workspaceId === null || project.workspaceId === query.workspaceId);
  const optionLabel = (option: ScopeOption) => `${option.name}${option.archived ? "（アーカイブ済み）" : ""}`;
  const filtered = query.scope !== "all" || (!fixedWorkspace && query.workspaceId !== null) || query.projectId !== null;
  const Wrapper = fixedWorkspace ? "div" : "main";
  return (
    <Wrapper>
      {!fixedWorkspace && (
        <div className="detail-hero">
          <p className="eyebrow">すべてのProject・Workspace</p>
          <h1>判断待ち</h1>
          <p className="section-note">参加しているWorkspaceと、その配下のProjectの相談をまとめて表示します。質問・選択肢・推奨・影響を読み、各相談の詳細から返信・決定してください。</p>
        </div>
      )}
      <section className="detail-section" aria-labelledby="consultation-inbox-heading">
        <h2 id="consultation-inbox-heading" className={fixedWorkspace ? undefined : "visually-hidden"}>{fixedWorkspace ? "対応待ち" : "相談の一覧"}</h2>
        <p className="section-note">{inboxOrderNotes[query.status]}{fixedWorkspace && "Workspaceと配下Projectの相談を表示します。任意のコメントやAgentだけで解消できる作業は含みません。"}</p>
        <div className="consultation-inbox-filters">
          <div className="consultation-inbox-filter">
            <span className="field-label" aria-hidden="true">状態</span>
            <ViewSwitch
              label="相談の状態"
              size="sm"
              items={consultationFilters.map((item) => ({ key: item, to: pathFor({ ...query, status: item }), label: consultationFilterLabels[item], current: item === query.status }))}
            />
          </div>
          <div className="consultation-inbox-filter">
            <span className="field-label" aria-hidden="true">scope</span>
            <ViewSwitch
              label="相談のscope"
              size="sm"
              items={inboxScopeFilters.map((item) => ({
                key: item,
                to: pathFor({ ...query, scope: item, ...(item === "workspace" ? { projectId: null } : {}) }),
                label: inboxScopeFilterLabels[item],
                current: item === query.scope,
              }))}
            />
          </div>
        </div>
        <div className="consultation-inbox-selects">
          {!fixedWorkspace && (
            <Field label="Workspace" layout="inline">
              <Select value={query.workspaceId ?? ""} onChange={(event) => change({ workspaceId: event.target.value || null, projectId: null })}>
                <option value="">すべてのWorkspace</option>
                {(options?.workspaces ?? []).map((workspace) => <option key={workspace.id} value={workspace.id}>{optionLabel(workspace)}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Project" layout="inline">
            <Select value={query.projectId ?? ""} onChange={(event) => change(event.target.value ? { projectId: event.target.value, scope: "project" } : { projectId: null })}>
              <option value="">すべてのProject</option>
              {projectChoices.map((project) => <option key={project.id} value={project.id}>{optionLabel(project)}</option>)}
            </Select>
          </Field>
          <div className="form-actions">
            <Button variant="secondary" size="sm" pending={pending === "reload"} onClick={() => void reload()}>{pending === "reload" ? "読み込み中..." : "最新の状態を読み込む"}</Button>
          </div>
        </div>
        {!settled ? (
          <Loading />
        ) : settled.error ? (
          <ErrorState message={settled.error} />
        ) : settled.consultations.length ? (
          <>
            <ConsultationList
              consultations={settled.consultations}
              pathOf={(consultation) => consultationDetailPath(scopeOfConsultation(consultation), consultation.id)}
              scopeLabelOf={(consultation) => describeConsultationScope(consultation, names)}
            />
            {moreError && <StateCard tone="error" role="alert">{moreError}</StateCard>}
            {settled.nextCursor && (
              <div className="form-actions">
                <Button variant="secondary" pending={pending === "more"} onClick={() => void loadMore()}>{pending === "more" ? "読み込み中..." : "さらに表示"}</Button>
              </div>
            )}
          </>
        ) : (
          <StateCard role="status">
            <p>{(fixedWorkspace ? workspaceEmptyMessages : emptyMessages)[query.status]}</p>
            {filtered && <p className="section-note">絞り込みを解除すると、他のProject・Workspaceの相談も表示します。</p>}
          </StateCard>
        )}
      </section>
    </Wrapper>
  );
};
