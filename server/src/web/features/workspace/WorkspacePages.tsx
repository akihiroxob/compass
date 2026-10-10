import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { Shell } from "../../components/Shell";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentStatusLabels, splitIntents, type Intent } from "../../intentForm";
import { workspaceApiPath } from "../../paths";
import type { Project } from "../../projectForm";
import { canOperateWorkspace } from "../../permissions";
import { archiveInit, describeArchiveFailure, parseListStatus, projectsApiPath, summarizeReason, validateArchiveReason, type ProjectStatus } from "../../projectArchive";
import { statusBadgeClass } from "../../statusTone";
import { ActivitySection } from "../activity";
import { IntentFacts } from "../intent/IntentFacts";
import { humanRoleLabels, type HumanRole } from "../member";
import { projectViewPath } from "../project/overview";
import { ProjectListSwitch } from "../project";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { chooseHomeWorkspace, withProjectAccess, workspaceCreatePath, workspaceEditPath, workspacePath, workspaceProjectCreatePath, workspaceProjectsPath, workspaceSectionLabels, type Workspace, type WorkspaceProject, type WorkspaceSection } from "./workspace";

/** 読込の状態。`key`は取得対象（URLのID・status）で、入力が変わった最初のrenderから前の結果を出さない。 */
type Loaded<T> = { key: string; value: T | null; error: string | null };

const useLoad = <T,>(key: string, load: () => Promise<T>, notFound: string): { value: T | null; error: string | null } => {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    let active = true;
    load()
      .then((value) => { if (active) setState({ key, value, error: null }); })
      .catch((reason: unknown) => { if (active) setState({ key, value: null, error: loadFailureMessage(classifyError(reason), notFound) }); });
    return () => { active = false; };
  }, [key]);
  return state?.key === key ? state : { value: null, error: null };
};

const workspaceNotFound = "Workspaceが見つからないか、このWorkspaceを閲覧する権限がありません。WorkspaceのownerにMembershipの追加を依頼してください。";

/** ホーム（`/`）。前回選択したWorkspace、無ければ一覧の先頭の概要へ移る。参加していなければ理由と次の行動を出す。 */
export const WorkspaceHomePage = () => {
  const navigation = useWorkspaceNavigation();
  if (!navigation || navigation.error) {
    return <Shell><main className="narrow"><div className="state-card error" role="alert"><p>Workspaceの一覧を読み込めませんでした: {navigation?.error ?? "不明なエラー"}</p>{navigation && <button type="button" className="secondary-button" onClick={navigation.reload}>再試行</button>}</div></main></Shell>;
  }
  const { workspaces, rememberedId } = navigation;
  if (workspaces === null) return <Shell><main className="narrow"><Loading /></main></Shell>;
  const home = chooseHomeWorkspace(workspaces, rememberedId);
  if (home) return <Navigate to={workspacePath(home.id)} replace />;
  return (
    <Shell>
      <main className="narrow">
        <div className="detail-hero"><p className="eyebrow">Workspace</p><h1>参加しているWorkspaceはありません</h1></div>
        <div className="state-card">
          <p>Workspaceは、Mission・Visionを共有して複数のProjectで成果を実現する単位です。Workspaceを作成するとあなたがownerになり、Projectを追加できます。</p>
          <p>既存のWorkspaceに参加するには、そのWorkspaceのownerにMembershipの追加を依頼してください。</p>
          <div className="action-row"><Link to={workspaceCreatePath} className="button">Workspaceを作成</Link><Link to="/projects" className="secondary-button">参加中のProject</Link></div>
        </div>
      </main>
    </Shell>
  );
};

/**
 * Workspaceの画面の共通枠。URLのWorkspaceをWorkspace Membershipで取得し、閲覧できなければ一覧に無いWorkspaceと同じく
 * 理由だけを出す（未所属・不在はserverが区別せず404）。見出しにWorkspace名・項目・状態・自分のRoleを出す。
 */
const WorkspaceFrame = ({ section, children }: { section: WorkspaceSection; children: (workspace: Workspace, myRole: HumanRole, reload: () => void) => ReactNode }) => {
  const { workspaceId = "" } = useParams();
  // archive等で状態が変わった後に取り直す。再取得中は読み込み中を出し、古い状態の操作を残さない。
  const [revision, setRevision] = useState(0);
  const { value, error } = useLoad(`${workspaceId}#${revision}`, () => request<{ workspace: Workspace; myRole: HumanRole }>(workspaceApiPath(workspaceId)), workspaceNotFound);
  return (
    <Shell>
      <main>
        {error ? <ErrorState message={error} /> : !value ? <Loading /> : (
          <>
            <div className="detail-hero project-hero">
              <p className="eyebrow">Workspace · {value.workspace.name}</p>
              <h1>{section === "overview" ? value.workspace.name : workspaceSectionLabels[section]}</h1>
              {value.workspace.status === "archived" && <p><span className="status-badge muted">アーカイブ済み</span></p>}
              <p className="section-note">あなたのWorkspaceでのRole: {humanRoleLabels[value.myRole]}</p>
            </div>
            {value.workspace.status === "archived" && (
              <section className="detail-section archive-notice" aria-labelledby="workspace-archive-heading">
                <h2 id="workspace-archive-heading">このWorkspaceはアーカイブされています</h2>
                <p className="section-note">参照のみできます。Workspaceの編集、Directionの変更、Projectの追加はできません。</p>
                <dl className="intent-facts"><dt>アーカイブの理由</dt><dd>{value.workspace.archiveReason ?? <span className="unset">理由は記録されていません</span>}</dd></dl>
              </section>
            )}
            <div className="view-panel">{children(value.workspace, value.myRole, () => setRevision((current) => current + 1))}</div>
          </>
        )}
      </main>
    </Shell>
  );
};

const TextList = ({ title, values }: { title: string; values: string[] }) => (
  <section className="detail-section"><h2>{title}</h2>{values.length ? <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul> : <p className="unset">未設定</p>}</section>
);

const useWorkspaceProjects = (workspaceId: string, status: ProjectStatus) =>
  useLoad(
    `${workspaceId}/${status}`,
    () =>
      Promise.all([
        request<{ projects: WorkspaceProject[] }>(workspaceApiPath(workspaceId, `/projects${status === "archived" ? "?status=archived" : ""}`)),
        request<{ projects: Project[] }>(projectsApiPath(status)),
      ]).then(([workspace, member]) => withProjectAccess(workspace.projects, new Set(member.projects.map(({ id }) => id)))),
    workspaceNotFound,
  );

const useWorkspaceIntents = (workspaceId: string) =>
  useLoad(workspaceId, () => request<{ intents: Intent[] }>(workspaceApiPath(workspaceId, "/intents")).then(({ intents }) => splitIntents(intents)), workspaceNotFound);

/**
 * Workspaceの管理（編集はadministrator以上、archiveはowner）。Workspace Membershipの`myRole`で導線を出し、Project Roleからは継承しない。
 * archiveすると一覧（Selector）から外れ、Directionの変更とProjectの追加ができなくなる。所属Projectのarchiveはしない。
 */
const ManageSection = ({ workspace, myRole, reload }: { workspace: Workspace; myRole: HumanRole; reload: () => void }) => {
  const navigation = useWorkspaceNavigation();
  const canUpdate = canOperateWorkspace(myRole, "workspace.update");
  const canArchive = canOperateWorkspace(myRole, "workspace.archive");
  const archive = useReasonAction(async (reason) => {
    const invalid = validateArchiveReason(reason);
    if (invalid) throw new Error(invalid);
    const sync = () => { navigation?.refreshWorkspace(workspace.id); reload(); };
    try {
      await request<{ workspace: Workspace }>(workspaceApiPath(workspace.id, "/archive"), archiveInit(reason));
      sync();
    } catch (failure) {
      // 他の操作で既にアーカイブされていた場合は、表示を最新（アーカイブ済み）へ揃えてから失敗を表示する。
      if (classifyError(failure).kind === "project_archived") sync();
      throw failure;
    }
  }, (classified) => (classified.kind === "not_found" ? workspaceNotFound : describeArchiveFailure(classified)));
  if (workspace.status === "archived" || !(canUpdate || canArchive)) return null;
  return (
    <section className="detail-section" aria-labelledby="workspace-manage-heading">
      <h2 id="workspace-manage-heading">Workspaceの管理</h2>
      <p className="section-note">名前・Mission・Vision・Principles・Constraintsの編集と、Workspaceのアーカイブです。</p>
      <div className="action-row">
        {canUpdate && <Link to={workspaceEditPath(workspace.id)} className="button">Workspaceを編集</Link>}
        {canArchive && <button type="button" className="secondary-button danger" aria-expanded={archive.confirming} onClick={archive.open}>アーカイブ</button>}
      </div>
      {canArchive && archive.confirming && <ReasonPanel action={archive} title="このWorkspaceをアーカイブしますか？" description="アーカイブすると、Workspaceの編集、Intent・Outcome等のDirectionの変更、Projectの追加ができなくなり、Workspaceの一覧から外れます。内容と履歴は参照できます。所属Projectはアーカイブされません。" label={<>アーカイブの理由 <span>必須</span></>} required confirmLabel="アーカイブする" pendingLabel="アーカイブ中..." />}
    </section>
  );
};

/** 概要。Mission・Visionと、現在地・要対応・Project・Agent・最近の記録（`WorkspaceOverview`）、Workspaceの管理。 */
const OverviewContent = ({ workspace, myRole, reload }: { workspace: Workspace; myRole: HumanRole; reload: () => void }) => (
  <>
    <section className="detail-section" aria-labelledby="workspace-mission-heading">
      <h2 id="workspace-mission-heading">Mission</h2>
      <p className="pre-wrap">{workspace.mission}</p>
      <h3>Vision</h3>
      {workspace.vision ? <p className="pre-wrap">{workspace.vision}</p> : <p className="unset">未設定</p>}
    </section>
    <WorkspaceOverview workspace={workspace} myRole={myRole} />
    <ManageSection workspace={workspace} myRole={myRole} reload={reload} />
  </>
);

/** 方向。Mission・Vision、Intent（Active・過去）、Principles・Constraints。いずれもWorkspaceが正本。 */
const DirectionContent = ({ workspace }: { workspace: Workspace }) => {
  const intents = useWorkspaceIntents(workspace.id);
  return (
    <>
      <section className="detail-section"><h2>Mission</h2><p className="pre-wrap">{workspace.mission}</p><h3>Vision</h3>{workspace.vision ? <p className="pre-wrap">{workspace.vision}</p> : <p className="unset">未設定</p>}</section>
      <section className="detail-section intent-section" aria-labelledby="workspace-direction-intent-heading">
        <h2 id="workspace-direction-intent-heading">Intent</h2>
        <p className="section-note">Humanが今実現したい状態です。このWorkspaceのProjectで共有し、達成や放棄で終わります。</p>
        {intents.error ? <ErrorState message={`Intentの読み込みに失敗しました: ${intents.error}`} /> : !intents.value ? <Loading /> : (
          <>
            {intents.value.active ? <article className="intent-card"><span className={statusBadgeClass("progress")}>{intentStatusLabels.active}</span><h3>{intents.value.active.title}</h3><IntentFacts intent={intents.value.active} /></article> : <p className="unset">ActiveなIntentはありません。</p>}
            {intents.value.past.length > 0 && <details className="past-intents"><summary>過去のIntent（{intents.value.past.length}件）</summary><ul>{intents.value.past.map((intent) => <li key={intent.id} className="plain-item"><span className="status-badge muted">{intentStatusLabels[intent.status]}</span> {intent.title}</li>)}</ul></details>}
          </>
        )}
      </section>
      <TextList title="Principles" values={workspace.principles} />
      <TextList title="Constraints" values={workspace.constraints} />
    </>
  );
};

/**
 * WorkspaceのProject一覧。Workspace Membershipで所属Project全体を見られるが、Project詳細はProject Membershipで認可されるため、
 * Membershipの無いProjectはリンクにせず理由を出す。
 */
const ProjectsContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const status = parseListStatus(useSearchParams()[0].get("status"));
  const { value, error } = useWorkspaceProjects(workspace.id, status);
  // Projectの追加はWorkspace Membershipのadministrator以上で、archivedのWorkspaceには追加できない。
  const canCreate = workspace.status === "active" && canOperateWorkspace(myRole, "project.create");
  return (
    <>
      <div className="action-row">
        <ProjectListSwitch status={status} pathOf={(next) => workspaceProjectsPath(workspace.id, next)} />
        {canCreate && <Link to={workspaceProjectCreatePath(workspace.id)} className="button">Projectを追加</Link>}
      </div>
      {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : value.length === 0 ? (
        <div className="state-card">{status === "archived" ? <p>アーカイブ済みのProjectはありません。</p> : workspace.status === "archived" ? <p>このWorkspaceにactiveなProjectはありません。アーカイブ済みのWorkspaceにはProjectを追加できません。</p> : canCreate ? <><p>このWorkspaceにactiveなProjectはまだありません。Missionを実現する実行の単位としてProjectを追加します。</p><Link to={workspaceProjectCreatePath(workspace.id)} className="text-link">Projectを追加 →</Link></> : <p>このWorkspaceにactiveなProjectはありません。WorkspaceへのProjectの追加はWorkspaceのadministratorが行います。</p>}</div>
      ) : (
        <section className="project-grid" aria-label={`${value.length}件のProject`}>
          {value.map(({ project, canOpen }) => {
            const body = <><p className="card-label">Project</p><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}{project.status === "archived" && <div className="mission-preview archive-preview"><span>アーカイブの理由</span>{summarizeReason(project.archiveReason)}</div>}{!canOpen && <p className="locked-note">Project Membershipが無いため詳細は開けません。Projectのownerに招待を依頼してください。</p>}<time>{new Date(project.updatedAt).toLocaleDateString("ja-JP")} 更新</time></>;
            return canOpen ? <Link className="project-card" to={`/projects/${project.id}`} key={project.id}>{body}</Link> : <article className="project-card locked" key={project.id}>{body}</article>;
          })}
        </section>
      )}
    </>
  );
};

/** 記録。WorkspaceのActivity（Direction等の意味のある履歴）。ProjectのWork履歴は各Projectの「記録」に分ける。 */
const ActivityContent = ({ workspace }: { workspace: Workspace }) => <ActivitySection scope={{ kind: "workspace", workspaceId: workspace.id }} resources={[]} />;

/**
 * Agent。ProjectのWorkを担うAgent（Role割当・Credential・Claim）は各Projectの「設定」で管理するため、開けるProjectへの導線を出す。
 */
const AgentsContent = ({ workspace }: { workspace: Workspace }) => {
  const { value, error } = useWorkspaceProjects(workspace.id, "active");
  return (
    <section className="detail-section" aria-labelledby="workspace-agents-heading">
      <h2 id="workspace-agents-heading">ProjectのAgent</h2>
      <p className="section-note">Story・Taskを担うAgentのRole割当とCredentialはProjectごとに管理します。Role割当やClaimはAgentプロセスの稼働を示しません。WorkspaceのDirectionを担うAgentの一覧は、まだWeb UIにありません。</p>
      {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : value.length === 0 ? <p className="unset">activeなProjectはありません。</p> : (
        <ul className="link-list workspace-agent-projects">
          {value.map(({ project, canOpen }) => <li key={project.id}>{canOpen ? <Link to={projectViewPath(project.id, "settings")}><span>{project.name}</span><small>Agent・Roleの割当を開く</small></Link> : <p><span>{project.name}</span><small>Project Membershipが無いため開けません</small></p>}</li>)}
        </ul>
      )}
    </section>
  );
};

export const WorkspaceOverviewPage = () => <WorkspaceFrame section="overview">{(workspace, myRole, reload) => <OverviewContent workspace={workspace} myRole={myRole} reload={reload} />}</WorkspaceFrame>;
export const WorkspaceDirectionPage = () => <WorkspaceFrame section="direction">{(workspace) => <DirectionContent workspace={workspace} />}</WorkspaceFrame>;
export const WorkspaceProjectsPage = () => <WorkspaceFrame section="projects">{(workspace, myRole) => <ProjectsContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceActivityPage = () => <WorkspaceFrame section="activity">{(workspace) => <ActivityContent workspace={workspace} />}</WorkspaceFrame>;
export const WorkspaceAgentsPage = () => <WorkspaceFrame section="agents">{(workspace) => <AgentsContent workspace={workspace} />}</WorkspaceFrame>;
