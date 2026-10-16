import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { Shell } from "../../components/Shell";
import { ErrorState, Loading } from "../../components/StateCard";
import { workspaceApiPath } from "../../paths";
import { workspaceDirectionAccess } from "../../useWorkspaceDirection";
import type { Project } from "../../projectForm";
import { canOperateWorkspace } from "../../permissions";
import { archiveInit, describeArchiveFailure, parseListStatus, projectsApiPath, summarizeReason, validateArchiveReason, type ProjectStatus } from "../../projectArchive";
import { ActivitySection } from "../activity";
import { ProjectAgentsSection, WorkspaceAgentsSection } from "../agent";
import { useSession } from "../auth";
import { CredentialSection } from "../credential";
import { AgentSettingsSection } from "../grant";
import { humanRoleLabels, WorkspaceMembershipSection, type HumanRole } from "../member";
import { projectViewPath } from "../project/overview";
import { ProjectListSwitch } from "../project";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import { loadDirection, loadOutcomeDetail, loadProjects, settle } from "./directionData";
import { DirectionIntents, WorkspaceOutcomeDetail } from "./WorkspaceDirection";
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

/**
 * 方向。Mission・Vision、Intent（Active・過去）→ Outcome → Target Project別のWork、Principles・Constraints。いずれもWorkspaceが正本で、
 * Target別のStory・Taskは件数だけを出し、本文は各OutcomeのWorkspace詳細でProject Membershipにより読む。
 */
const DirectionContent = ({ workspace }: { workspace: Workspace }) => {
  const { value, error } = useLoad(workspace.id, () => Promise.all([loadDirection(workspace.id), settle(loadProjects(workspace.id), workspaceNotFound)]), workspaceNotFound);
  return (
    <>
      <section className="detail-section"><h2>Mission</h2><p className="pre-wrap">{workspace.mission}</p><h3>Vision</h3>{workspace.vision ? <p className="pre-wrap">{workspace.vision}</p> : <p className="unset">未設定</p>}</section>
      <section className="detail-section intent-section" aria-labelledby="workspace-direction-intent-heading">
        <h2 id="workspace-direction-intent-heading">Intent・Outcome</h2>
        <p className="section-note">IntentはHumanが今実現したい状態、OutcomeはIntentへ近づくために達成すべき観測可能な状態です。OutcomeはWorkspaceに属し、Target ProjectのStoryが貢献します。</p>
        {error ? <ErrorState message={`Intent・Outcomeの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : <DirectionIntents workspaceId={workspace.id} direction={value[0]} projects={value[1]} />}
      </section>
      <TextList title="Principles" values={workspace.principles} />
      <TextList title="Constraints" values={workspace.constraints} />
    </>
  );
};

const outcomeNotFound = "Outcomeが見つからないか、このWorkspaceを閲覧する権限がありません。";

/** WorkspaceのOutcome詳細。Outcome・Target別の還流・EvaluationはWorkspace Membership、Story・TaskはProject Membershipで読む。 */
const OutcomeContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const { intentId = "", outcomeId = "" } = useParams();
  const { value, error } = useLoad(`${workspace.id}/${intentId}/${outcomeId}`, () => Promise.all([loadOutcomeDetail(workspace.id, intentId, outcomeId, outcomeNotFound), settle(loadProjects(workspace.id), workspaceNotFound)]), outcomeNotFound);
  if (error) return <><Link to={workspacePath(workspace.id, "direction")} className="back-link">← 方向</Link><ErrorState message={error} /></>;
  return !value ? <Loading /> : <WorkspaceOutcomeDetail workspaceId={workspace.id} data={value[0]} projects={value[1]} canEdit={workspaceDirectionAccess(workspace, myRole) === "allowed"} />;
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

/**
 * 所属Projectのview（記録・設定）への導線。Project詳細はProject Membershipで認可するため、Membershipの無いProjectはリンクにせず理由を出す。
 */
const ProjectViewLinks = ({ workspace, view, hint }: { workspace: Workspace; view: "records" | "settings"; hint: string }) => {
  const { value, error } = useWorkspaceProjects(workspace.id, "active");
  return error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : value.length === 0 ? <p className="unset">activeなProjectはありません。</p> : (
    <ul className="link-list workspace-project-links">
      {value.map(({ project, canOpen }) => <li key={project.id}>{canOpen ? <Link to={projectViewPath(project.id, view)}><span>{project.name}</span><small>{hint}</small></Link> : <p><span>{project.name}</span><small>Project Membershipが無いため開けません</small></p>}</li>)}
    </ul>
  );
};

/**
 * Workspace Activityの`project_resource`参照の表示先。Workspaceの所属Project（archivedを含む）に登録済みのRepository・Resourceで、
 * Workspace Membershipで読める。取得できなければnull（参照はIDだけを出す）。
 */
const useWorkspaceResources = (workspaceId: string) => {
  const { value, error } = useLoad(
    `${workspaceId}/resources`,
    () =>
      Promise.all(["", "?status=archived"].map((query) => request<{ projects: WorkspaceProject[] }>(workspaceApiPath(workspaceId, `/projects${query}`)))).then((pages) =>
        pages.flatMap(({ projects }) => projects.flatMap((project) => [...project.repositories, ...project.resources])),
      ),
    workspaceNotFound,
  );
  return error ? { ready: true, resources: null } : { ready: value !== null, resources: value };
};

/**
 * 記録。WorkspaceのActivity（Directionの判断の履歴）と、各ProjectのActivity（Workの履歴）への導線。Project ActivityはProject Membershipで
 * 各Projectの「記録」から読み、Workspaceの一覧には混ぜない。
 */
const ActivityContent = ({ workspace }: { workspace: Workspace }) => {
  const { ready, resources } = useWorkspaceResources(workspace.id);
  return (
    <>
      {ready ? <ActivitySection scope={{ kind: "workspace", workspaceId: workspace.id }} resources={resources} /> : <Loading />}
      <section className="detail-section" aria-labelledby="workspace-project-activity-heading">
        <h2 id="workspace-project-activity-heading">Projectの記録</h2>
        <p className="section-note">Story・Taskの起票・レビュー・受入などWorkの履歴は、Projectごとに記録されます。Project Membershipのあるactive Projectから開けます。</p>
        <ProjectViewLinks workspace={workspace} view="records" hint="Projectの記録を開く" />
      </section>
    </>
  );
};

/**
 * Agent。WorkspaceのDirection Role（Workspace Grant・Workspace Credential）と、所属ProjectのExecution Role（Project Grant・
 * Project Credential・TaskのClaim）をscopeごとに分けて出す。Grant・Credential・ClaimのいずれからもAgentの稼働を推測しない。
 */
const AgentsContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const { value, error } = useWorkspaceProjects(workspace.id, "active");
  return (
    <>
      <div className="fixed-note agent-intro">
        <p><strong>Grant</strong>はAgentが担当できるRole、<strong>Credential</strong>はAgentがCompassへ接続する資格、<strong>Claim</strong>はAgentが今保持しているTaskの期限付きの作業権です。</p>
        <p>それぞれ別の状態で、いずれもAgentプロセスが稼働していることを示しません。</p>
      </div>
      <WorkspaceAgentsSection workspace={workspace} myRole={myRole} />
      {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : <ProjectAgentsSection projects={value} />}
    </>
  );
};

/**
 * 設定。Workspace scopeのMember（Workspace Membership）・Direction Agent（Workspace Grant）・Workspace Credentialと、Project別の
 * アクセス（各Projectの設定）への導線。WorkspaceとProjectの権限は互いに継承しないため、ProjectのMember・Role割当・Credentialは
 * ここで変更しない。導線の表示は`myRole`で決め、拒否は常にserverが行う。
 */
const SettingsContent = ({ workspace, myRole, reload }: { workspace: Workspace; myRole: HumanRole; reload: () => void }) => {
  const session = useSession();
  const navigation = useWorkspaceNavigation();
  const archived = workspace.status === "archived";
  const canManageCredential = canOperateWorkspace(myRole, "credential.manage");
  const scope = { kind: "workspace", id: workspace.id } as const;
  return (
    <>
      <div className="fixed-note">
        <p>ここではWorkspace（Mission・Direction）を利用するHumanと、Directionを担うAgentを管理します。WorkspaceのRoleは所属ProjectのStory・Taskの権限を与えず、ProjectのRoleもWorkspaceの権限を与えません。</p>
      </div>
      <WorkspaceMembershipSection
        key={myRole}
        workspaceId={workspace.id}
        currentHumanId={session?.human.id ?? null}
        manage={canOperateWorkspace(myRole, "member.manage")}
        readOnly={archived}
        onSelfChanged={() => { navigation?.refreshWorkspace(workspace.id); reload(); }}
      />
      <AgentSettingsSection scope={scope} readOnly={archived || !canOperateWorkspace(myRole, "grant.manage")} showCredentials={canManageCredential} />
      {canManageCredential ? <CredentialSection scope={scope} readOnly={archived} /> : (
        <section className="detail-section" aria-labelledby="workspace-credential-heading">
          <h2 id="workspace-credential-heading">Agent・Runtime Credential</h2>
          <p className="section-note">WorkspaceのCredentialの一覧・発行・取消は、Workspaceのadministrator以上が行います。あなたのRole（{humanRoleLabels[myRole]}）では表示されません。</p>
        </section>
      )}
      <section className="detail-section" aria-labelledby="workspace-project-access-heading">
        <h2 id="workspace-project-access-heading">Projectのアクセス</h2>
        <p className="section-note">ProjectのMember・招待、Story・Taskを担うAgent（Manager・Worker・Reviewer）の割当とCredentialは、Projectごとの設定で管理します。Workspaceのowner・administratorでも、Project Membershipが無いProjectは開けません。</p>
        <ProjectViewLinks workspace={workspace} view="settings" hint="Member・Agent・Credentialを開く" />
      </section>
    </>
  );
};

export const WorkspaceOverviewPage = () => <WorkspaceFrame section="overview">{(workspace, myRole, reload) => <OverviewContent workspace={workspace} myRole={myRole} reload={reload} />}</WorkspaceFrame>;
export const WorkspaceDirectionPage = () => <WorkspaceFrame section="direction">{(workspace) => <DirectionContent workspace={workspace} />}</WorkspaceFrame>;
export const WorkspaceOutcomePage = () => <WorkspaceFrame section="direction">{(workspace, myRole) => <OutcomeContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceProjectsPage = () => <WorkspaceFrame section="projects">{(workspace, myRole) => <ProjectsContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceActivityPage = () => <WorkspaceFrame section="activity">{(workspace) => <ActivityContent workspace={workspace} />}</WorkspaceFrame>;
export const WorkspaceAgentsPage = () => <WorkspaceFrame section="agents">{(workspace, myRole) => <AgentsContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceSettingsPage = () => <WorkspaceFrame section="settings">{(workspace, myRole, reload) => <SettingsContent workspace={workspace} myRole={myRole} reload={reload} />}</WorkspaceFrame>;
