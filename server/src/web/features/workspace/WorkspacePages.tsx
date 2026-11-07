import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request, settle } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, LinkButton } from "../../components/ui";
import { projectViewPath, workspaceApiPath, workspaceCreatePath, workspaceEditPath, workspaceIntentCreatePath, workspacePath, workspaceProjectCreatePath, workspaceMembersPagePath, workspaceProjectsPath, type WorkspaceSection } from "../../paths";
import { canOperateWorkspace, workspaceDirectionAccess } from "../access";
import { WorkspaceActivityStream } from "../activity";
import { WorkspaceAgentDetail, WorkspaceAgentList } from "../agent";
import { ConsultationSection } from "../consultation";
import { useSession } from "../auth";
import { CredentialSection } from "../credential";
import { DirectionPanel, loadDirection, loadOutcomeDetail } from "../direction";
import { AgentSettingsSection } from "../grant";
import { humanRoleLabels, RoleHelpButton, WorkspaceInvitationSection, WorkspaceMembershipSection, type HumanRole } from "../member";
import { archiveInit, describeArchiveFailure, parseListStatus, ProjectListSwitch, summarizeReason, validateArchiveReason, type ProjectStatus } from "../project";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import { DirectionIntents, WorkspaceOutcomeDetail } from "./WorkspaceDirection";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { chooseHomeWorkspace, workspaceSectionLabels, type Workspace, type WorkspaceProject } from "./workspace";
import { loadProjects } from "./workspaceProjects";

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
    return <main className="narrow"><StateCard tone="error" role="alert"><p>Workspaceの一覧を読み込めませんでした: {navigation?.error ?? "不明なエラー"}</p>{navigation && <Button variant="secondary" onClick={navigation.reload}>再試行</Button>}</StateCard></main>;
  }
  const { workspaces, rememberedId } = navigation;
  if (workspaces === null) return <main className="narrow"><Loading /></main>;
  const home = chooseHomeWorkspace(workspaces, rememberedId);
  if (home) return <Navigate to={workspacePath(home.id)} replace />;
  return (
    <main className="narrow">
      <div className="detail-hero"><p className="eyebrow">Workspace</p><h1>参加しているWorkspaceはありません</h1></div>
      <StateCard>
        <p>Workspaceは、Mission・Visionを共有して複数のProjectで成果を実現する単位です。Workspaceを作成するとあなたがownerになり、Projectを追加できます。</p>
        <p>既存のWorkspaceに参加するには、そのWorkspaceのownerにMembershipの追加を依頼してください。</p>
        <div className="action-row"><LinkButton to={workspaceCreatePath}>Workspaceを作成</LinkButton><LinkButton variant="secondary" to="/projects">参加中のProject</LinkButton></div>
      </StateCard>
    </main>
  );
};

/**
 * Workspaceの画面の共通枠。URLのWorkspaceをWorkspace Membershipで取得し、閲覧できなければ一覧に無いWorkspaceと同じく
 * 理由だけを出す（未所属・不在はserverが区別せず404）。見出しにWorkspace名・項目・状態・自分のRoleを出す。
 */
const WorkspaceFrame = ({ section, title, children }: { section: WorkspaceSection; title?: string; children: (workspace: Workspace, myRole: HumanRole, reload: () => void) => ReactNode }) => {
  const { workspaceId = "" } = useParams();
  // archive等で状態が変わった後に取り直す。再取得中は読み込み中を出し、古い状態の操作を残さない。
  const [revision, setRevision] = useState(0);
  const { value, error } = useLoad(`${workspaceId}#${revision}`, () => request<{ workspace: Workspace; myRole: HumanRole }>(workspaceApiPath(workspaceId)), workspaceNotFound);
  return (
    <main>
      {error ? <ErrorState message={error} /> : !value ? <Loading /> : (
        <>
          <div className="detail-hero project-hero">
            <p className="eyebrow">Workspace · {value.workspace.name}</p>
            <h1>{title ?? (section === "overview" ? value.workspace.name : workspaceSectionLabels[section])}</h1>
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
  );
};

const TextList = ({ title, values }: { title: string; values: string[] }) => (
  <section className="detail-section"><h2>{title}</h2>{values.length ? <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul> : <p className="unset">未設定</p>}</section>
);

const useWorkspaceProjects = (workspaceId: string, status: ProjectStatus) =>
  useLoad(
    `${workspaceId}/${status}`,
    () =>
      request<{ projects: WorkspaceProject[] }>(workspaceApiPath(workspaceId, `/projects${status === "archived" ? "?status=archived" : ""}`))
        .then(({ projects }) => projects),
    workspaceNotFound,
  );

/**
 * Workspaceの管理（編集はadministrator以上、archiveはowner）。Workspace Membershipの`myRole`で導線を出す。
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
        {canUpdate && <LinkButton to={workspaceEditPath(workspace.id)}>Workspaceを編集</LinkButton>}
        {canArchive && <Button variant="secondary" tone="danger" aria-expanded={archive.confirming} onClick={archive.open}>アーカイブ</Button>}
      </div>
      {canArchive && archive.confirming && <ReasonPanel action={archive} title="このWorkspaceをアーカイブしますか？" description="アーカイブすると、Workspaceの編集、Intent・Outcome等のDirectionの変更、Projectの追加ができなくなり、Workspaceの一覧から外れます。内容と履歴は参照できます。所属Projectはアーカイブされません。" label="アーカイブの理由" required confirmLabel="アーカイブする" pendingLabel="アーカイブ中..." />}
    </section>
  );
};

/** 概要。Mission・Visionの帯と、要対応・現在地・最近の記録・Project・Agent（`WorkspaceOverview`）、補助列のWorkspaceの管理。 */
const OverviewContent = ({ workspace, myRole, reload }: { workspace: Workspace; myRole: HumanRole; reload: () => void }) => (
  <>
    <DirectionPanel mission={workspace.mission} vision={workspace.vision} />
    <WorkspaceOverview workspace={workspace} myRole={myRole} manage={<ManageSection workspace={workspace} myRole={myRole} reload={reload} />} />
  </>
);

/**
 * 方向。Mission・Vision、Intent（Active・過去）→ Outcome → Target Project別のWork、Principles・Constraints。いずれもWorkspaceが正本で、
 * Target別のStory・Taskは件数だけを出し、本文は各OutcomeのWorkspace詳細で各ProjectのExecution閲覧から読む。
 */
const DirectionContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const { value, error } = useLoad(workspace.id, () => Promise.all([loadDirection(workspace.id), settle(loadProjects(workspace.id), workspaceNotFound)]), workspaceNotFound);
  return (
    <>
      <DirectionPanel mission={workspace.mission} vision={workspace.vision} />
      <section className="detail-section intent-section" aria-labelledby="workspace-direction-intent-heading">
        <h2 id="workspace-direction-intent-heading">Intent・Outcome</h2>
        <p className="section-note">IntentはHumanが今実現したい状態、OutcomeはIntentへ近づくために達成すべき観測可能な状態です。OutcomeはWorkspaceに属し、Target ProjectのStoryが貢献します。</p>
        {workspaceDirectionAccess(workspace, myRole) === "allowed" && <div className="action-row"><LinkButton size="sm" to={workspaceIntentCreatePath(workspace.id)}>目標を作成</LinkButton></div>}
        {error ? <ErrorState message={`Intent・Outcomeの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : <DirectionIntents workspaceId={workspace.id} direction={value[0]} projects={value[1]} canEdit={workspaceDirectionAccess(workspace, myRole) === "allowed"} />}
      </section>
      <TextList title="Principles" values={workspace.principles} />
      <TextList title="Constraints" values={workspace.constraints} />
    </>
  );
};

const outcomeNotFound = "Outcomeが見つからないか、このWorkspaceを閲覧する権限がありません。";

/** WorkspaceのOutcome詳細。Outcome・Target別の還流・Evaluationと、Target ProjectのStory・Taskを同じWorkspace Membershipで読む。 */
const OutcomeContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const { intentId = "", outcomeId = "" } = useParams();
  const { value, error } = useLoad(`${workspace.id}/${intentId}/${outcomeId}`, () => Promise.all([loadOutcomeDetail(workspace.id, intentId, outcomeId, outcomeNotFound), settle(loadProjects(workspace.id), workspaceNotFound)]), outcomeNotFound);
  if (error) return <><Link to={workspacePath(workspace.id, "direction")} className="back-link">← 方向</Link><ErrorState message={error} /></>;
  return !value ? <Loading /> : <WorkspaceOutcomeDetail workspaceId={workspace.id} data={value[0]} projects={value[1]} canEdit={workspaceDirectionAccess(workspace, myRole) === "allowed"} />;
};

/** WorkspaceのProject一覧。Workspace Memberは配下のすべてのProjectを同じRoleで開ける（ADR 0003）。 */
const ProjectsContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const status = parseListStatus(useSearchParams()[0].get("status"));
  const { value, error } = useWorkspaceProjects(workspace.id, status);
  // Projectの追加はWorkspace Membershipのadministrator以上で、archivedのWorkspaceには追加できない。
  const canCreate = workspace.status === "active" && canOperateWorkspace(myRole, "project.create");
  return (
    <>
      <div className="list-toolbar">
        <ProjectListSwitch status={status} size="sm" pathOf={(next) => workspaceProjectsPath(workspace.id, next)} />
        {canCreate && <LinkButton to={workspaceProjectCreatePath(workspace.id)} size="sm">Projectを追加</LinkButton>}
      </div>
      {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : value.length === 0 ? (
        <StateCard>{status === "archived" ? <p>アーカイブ済みのProjectはありません。</p> : workspace.status === "archived" ? <p>このWorkspaceにactiveなProjectはありません。アーカイブ済みのWorkspaceにはProjectを追加できません。</p> : canCreate ? <><p>このWorkspaceにactiveなProjectはまだありません。Missionを実現する実行の単位としてProjectを追加します。</p><Link to={workspaceProjectCreatePath(workspace.id)} className="text-link">Projectを追加 →</Link></> : <p>このWorkspaceにactiveなProjectはありません。WorkspaceへのProjectの追加はWorkspaceのadministratorが行います。</p>}</StateCard>
      ) : (
        <section className="project-grid" aria-label={`${value.length}件のProject`}>
          {value.map((project) => (
            <Link className="project-card" to={`/projects/${project.id}`} key={project.id}><p className="card-label">Project</p><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}{project.status === "archived" && <div className="mission-preview archive-preview"><span>アーカイブの理由</span>{summarizeReason(project.archiveReason)}</div>}<time>{new Date(project.updatedAt).toLocaleDateString("ja-JP")} 更新</time></Link>
          ))}
        </section>
      )}
    </>
  );
};

/** 所属Projectのview（記録・設定）への導線。 */
const ProjectViewLinks = ({ workspace, view, hint }: { workspace: Workspace; view: "records" | "settings"; hint: string }) => {
  const { value, error } = useWorkspaceProjects(workspace.id, "active");
  return error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : !value ? <Loading /> : value.length === 0 ? <p className="unset">activeなProjectはありません。</p> : (
    <ul className="link-list workspace-project-links">
      {value.map((project) => <li key={project.id}><Link to={projectViewPath(project.id, view)}><span>{project.name}</span><small>{hint}</small></Link></li>)}
    </ul>
  );
};

/**
 * Workspaceの記録の対象Projectと`project_resource`参照の表示先。Workspaceの所属Project（archivedを含む）で、Workspace Membershipで読める。
 * 取得できなければnull（Project名・参照はIDだけを出す）。
 */
const useWorkspaceActivityTargets = (workspaceId: string) => {
  const { value, error } = useLoad(
    `${workspaceId}/activity-targets`,
    () => loadProjects(workspaceId).then((items) => items.map(({ project }) => project)),
    workspaceNotFound,
  );
  if (error) return { ready: true, projects: null, resources: null };
  return {
    ready: value !== null,
    projects: value?.map((project) => ({ id: project.id, name: project.name, archived: project.status === "archived" })) ?? null,
    resources: value?.flatMap((project) => [...project.repositories, ...project.resources]) ?? null,
  };
};

/** 記録。Workspace共通と所属全Projectの業務Activityを横断して検索・絞り込み・詳細まで辿る。 */
const ActivityContent = ({ workspace }: { workspace: Workspace }) => {
  const { ready, projects, resources } = useWorkspaceActivityTargets(workspace.id);
  return ready ? <WorkspaceActivityStream workspaceId={workspace.id} projects={projects} resources={resources} /> : <Loading />;
};

/**
 * 設定。Workspace scopeのMember（Workspace Membership）・Direction Agent（Workspace Grant）・Workspace Credentialと、Project別の
 * アクセス（各Projectの設定）への導線。ProjectのAgentのRole割当・Credentialは
 * ここで変更しない。導線の表示は`myRole`で決め、拒否は常にserverが行う。
 */
const SettingsContent = ({ workspace, myRole }: { workspace: Workspace; myRole: HumanRole }) => {
  const archived = workspace.status === "archived";
  const canManageCredential = canOperateWorkspace(myRole, "credential.manage");
  const scope = { kind: "workspace", id: workspace.id } as const;
  return (
    <>
      <div className="fixed-note">
        <p>ここではDirectionを担うAgentとCredentialを管理します。HumanのMemberとRoleは<Link to={workspaceMembersPagePath(workspace.id)}>Member管理</Link>で扱い、配下のすべてのProjectに同じく適用されます。Workspace・全ProjectのAgentの一覧・登録・Credentialは<Link to={workspacePath(workspace.id, "agents")}>Agent管理</Link>でまとめて扱えます（Runtime Credentialはここと各Projectの設定で扱います）。</p>
      </div>
      <AgentSettingsSection scope={scope} readOnly={archived || !canOperateWorkspace(myRole, "grant.manage")} showCredentials={canManageCredential} />
      {canManageCredential ? <CredentialSection scope={scope} readOnly={archived} /> : (
        <section className="detail-section" aria-labelledby="workspace-credential-heading">
          <h2 id="workspace-credential-heading">Agent・Runtime Credential</h2>
          <p className="section-note">WorkspaceのCredentialの一覧・発行・取消は、Workspaceのadministrator以上が行います。あなたのRole（{humanRoleLabels[myRole]}）では表示されません。</p>
        </section>
      )}
      <section className="detail-section" aria-labelledby="workspace-project-access-heading">
        <h2 id="workspace-project-access-heading">Projectのアクセス</h2>
        <p className="section-note">Story・Taskを担うAgent（Manager・Worker・Reviewer）の割当とCredentialは、Agent管理または各Projectの設定で管理します。HumanのMemberとRoleはMember管理で扱い、配下のすべてのProjectに適用されます。</p>
        <ProjectViewLinks workspace={workspace} view="settings" hint="Agent・Credentialを開く" />
      </section>
    </>
  );
};

export const WorkspaceOverviewPage = () => <WorkspaceFrame section="overview">{(workspace, myRole, reload) => <OverviewContent workspace={workspace} myRole={myRole} reload={reload} />}</WorkspaceFrame>;
export const WorkspaceDirectionPage = () => <WorkspaceFrame section="direction">{(workspace, myRole) => <DirectionContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceOutcomePage = () => <WorkspaceFrame section="direction">{(workspace, myRole) => <OutcomeContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceConsultationsPage = () => <WorkspaceFrame section="consultations">{(workspace) => <ConsultationSection scope={{ kind: "workspace", workspaceId: workspace.id }} />}</WorkspaceFrame>;
export const WorkspaceProjectsPage = () => <WorkspaceFrame section="projects">{(workspace, myRole) => <ProjectsContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceActivityPage = () => <WorkspaceFrame section="activity">{(workspace) => <ActivityContent workspace={workspace} />}</WorkspaceFrame>;
export const WorkspaceAgentsPage = () => <WorkspaceFrame section="agents">{(workspace, myRole) => <WorkspaceAgentList workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
export const WorkspaceAgentPage = () => {
  const { principalId = "" } = useParams();
  return <WorkspaceFrame section="agents" title={principalId}>{(workspace, myRole) => <WorkspaceAgentDetail key={principalId} workspace={workspace} myRole={myRole} principalId={principalId} />}</WorkspaceFrame>;
};
/** Member管理。参加者の検索・Role変更・除外と招待をWorkspace scopeで扱う（Projectには置かない）。 */
const MembersContent = ({ workspace, myRole, reload }: { workspace: Workspace; myRole: HumanRole; reload: () => void }) => {
  const session = useSession();
  const navigation = useWorkspaceNavigation();
  const archived = workspace.status === "archived";
  return (
    <>
      <div className="list-toolbar">
        <LinkButton variant="secondary" size="sm" to={workspacePath(workspace.id, "settings")}>設定へ戻る</LinkButton>
        <RoleHelpButton workspaceName={workspace.name} size="sm" />
      </div>
      <p className="section-note">変更・除外・招待は、{workspace.name}と配下のすべてのProjectの利用に反映されます。</p>
      <WorkspaceMembershipSection
        key={myRole}
        workspaceId={workspace.id}
        currentHumanId={session?.human.id ?? null}
        manage={canOperateWorkspace(myRole, "member.manage")}
        readOnly={archived}
        onSelfChanged={() => { navigation?.refreshWorkspace(workspace.id); reload(); }}
      />
      {canOperateWorkspace(myRole, "invitation.manage") && <WorkspaceInvitationSection workspaceId={workspace.id} readOnly={archived} />}
    </>
  );
};

export const WorkspaceMembersPage = () => <WorkspaceFrame section="settings" title="Member">{(workspace, myRole, reload) => <MembersContent workspace={workspace} myRole={myRole} reload={reload} />}</WorkspaceFrame>;
export const WorkspaceSettingsPage = () => <WorkspaceFrame section="settings">{(workspace, myRole) => <SettingsContent workspace={workspace} myRole={myRole} />}</WorkspaceFrame>;
