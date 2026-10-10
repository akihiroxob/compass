import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import type { Project } from "../../projectForm";
import { archiveInit, archiveProjectPath, describeArchiveFailure, projectListPath, projectStatusLabels, validateArchiveReason } from "../../projectArchive";
import { ActivitySection } from "../activity";
import { AdrReferenceSection } from "../adr";
import { CredentialSection } from "../credential";
import { ClaimHolderSection, ExecutionSection } from "../execution";
import { AgentSettingsSection } from "../grant";
import { IntentSection } from "../intent";
import { useSession } from "../auth";
import { workspaceProjectsPath } from "../workspace/workspace";
import { useWorkspaceNavigation } from "../workspace/WorkspaceContext";
import { humanRoleLabels, MembershipSection, type HumanRole } from "../member";
import { canOperate } from "../../permissions";
import { useProjectWorkspaceDirection } from "../../useWorkspaceDirection";
import { ResearchSection } from "../research";
import { ProjectOverview } from "./ProjectOverview";
import { parseProjectView, projectViewLabels, projectViewPath, projectViews, type ProjectView } from "./overview";

const ListSection = ({ title, values }: { title: string; values: string[] }) => <section className="detail-section"><h2>{title}</h2>{values.length ? <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul> : <p className="unset">未設定</p>}</section>;
const LinkSection = ({ title, values }: { title: string; values: ({ id: string; name: string; url: string; kind?: string | null })[] }) => <section className="detail-section"><h2>{title}</h2>{values.length ? <div className="link-list">{values.map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={item.id}><span>{item.name}</span><small>{item.kind || item.url}</small></a>)}</div> : <p className="unset">未設定</p>}</section>;

/** 状態・理由・日時。archivedのProjectだけに出し、復帰できるかのような文言は置かない。 */
const ArchiveNotice = ({ project }: { project: Project }) => <section className="detail-section archive-notice" aria-labelledby="archive-heading"><h2 id="archive-heading"><span className="status-badge muted">{projectStatusLabels.archived}</span> このProjectはアーカイブされています</h2><p className="section-note">参照のみできます。Projectの編集、Agent・RuntimeのRoleの割当の変更はできません。IntentやOutcomeは所属Workspaceのもので、変更できるかはWorkspaceの状態で決まります。所属Workspaceに他のactiveなProjectが無かった場合はWorkspaceもアーカイブされ、Directionも変更できません。</p><dl className="intent-facts"><dt>アーカイブの理由</dt><dd>{project.archiveReason ?? <span className="unset">理由は記録されていません</span>}</dd><dt>アーカイブした日時</dt><dd>{project.archivedAt === null ? <span className="unset">記録されていません</span> : new Date(project.archivedAt).toLocaleString("ja-JP")}</dd></dl></section>;

/** viewの切替。選択中に`aria-current="page"`。リンクのままなのでview切替でfocusを失わない。 */
const ProjectViewNav = ({ projectId, current }: { projectId: string; current: ProjectView }) => <nav className="project-view-nav" aria-label="Projectの表示"><ul>{projectViews.map((view) => <li key={view}><Link to={projectViewPath(projectId, view)} aria-current={view === current ? "page" : undefined}>{projectViewLabels[view]}</Link></li>)}</ul></nav>;

export const ProjectDetailPage = () => {
  const { projectId = "" } = useParams(); const [project, setProject] = useState<Project | null>(null); const [myRole, setMyRole] = useState<HumanRole | null>(null); const [error, setError] = useState<string | null>(null);
  const [searchParams] = useSearchParams(); const view = parseProjectView(searchParams.get("view"));
  const session = useSession();
  // Intent・Outcome・Research・ADR参照は所属WorkspaceのDirection。Workspace Membershipで閲覧・変更の可否が決まり、Project Membershipから継承しない。
  // Projectのarchiveで所属Workspaceもarchiveされうるため、archive後はrevisionを進めてWorkspaceの状態を再取得する。
  const [directionRevision, setDirectionRevision] = useState(0);
  const navigation = useWorkspaceNavigation();
  const direction = useProjectWorkspaceDirection(projectId, directionRevision);
  const directionUnavailable = direction.access === "error" ? <ErrorState message={direction.message} /> : <Loading />;
  const load = () => request<{ project: Project; myRole: HumanRole }>(`/api/projects/${projectId}`).then(({ project, myRole }) => { setProject(project); setMyRole(myRole); return project; });
  // 未所属・取消済み・存在しないProjectはserverが区別せず404を返す（存在を漏らさない）。
  const showLoadError = (reason: unknown) => { setProject(null); setError(loadFailureMessage(classifyError(reason), "Projectが見つからないか、このProjectを閲覧する権限がありません。Projectのownerに招待を依頼してください。")); };
  useEffect(() => { load().catch(showLoadError); }, [projectId]);
  const archive = useReasonAction(async (reason) => {
    const invalid = validateArchiveReason(reason);
    if (invalid) throw new Error(invalid);
    // 本文のDirectionと、Shell・Selector・ホームが使うWorkspaceの一覧・状態を同じ再取得で揃える。
    const syncWorkspace = (archived: Project | undefined) => { setDirectionRevision((revision) => revision + 1); if (archived) navigation?.refreshWorkspace(archived.workspaceId); };
    try { const { project: archived } = await request<{ project: Project }>(archiveProjectPath(projectId), archiveInit(reason)); setProject(archived); syncWorkspace(archived); } catch (failure) {
      // 他の操作で既にアーカイブされていた場合は、表示を最新（アーカイブ済み）へ揃えてから失敗を表示する。
      if (classifyError(failure).kind === "project_archived") syncWorkspace(await load().catch(() => undefined));
      throw failure;
    }
  }, describeArchiveFailure);
  const archived = project?.status === "archived";
  // 戻り先は所属WorkspaceのProject一覧。Workspaceを閲覧できない（Project Membershipだけの）場合と読込失敗は参加中のProject。
  // 導線の表示だけをRoleで切り替える。拒否は常にserverが行う。
  const canUpdate = canOperate(myRole, "project.update"); const canArchive = canOperate(myRole, "project.archive"); const directionAccess = direction.access === "loading" || direction.access === "error" ? "forbidden" : direction.access; const grantReadOnly = archived || !canOperate(myRole, "grant.manage"); const canManageCredential = canOperate(myRole, "credential.manage");
  const permissions = { directionWrite: direction.access === "allowed", intervene: canOperate(myRole, "execution.intervene"), grantManage: canOperate(myRole, "grant.manage"), credentialManage: canManageCredential };
  return <Shell><main className="narrow">{project && direction.access !== "error" ? <><Link to={workspaceProjectsPath(project.workspaceId)} className="back-link">← Project一覧</Link>{archived && <> <Link to={workspaceProjectsPath(project.workspaceId, "archived")} className="back-link">アーカイブ済み一覧</Link></>}</> : <Link to={projectListPath(archived ? "archived" : "active")} className="back-link">← 参加中のProject</Link>}{error ? <ErrorState message={error} /> : !project ? <Loading /> : <><div className="detail-hero project-hero"><p className="eyebrow">Project</p><h1>{project.name}</h1>{archived && <p><span className="status-badge muted">{projectStatusLabels.archived}</span></p>}{project.description && <p className="lede">{project.description}</p>}<time>{new Date(project.updatedAt).toLocaleString("ja-JP")} 更新</time>{myRole && <p className="section-note">あなたのRole: {humanRoleLabels[myRole]}</p>}</div>{archived && <ArchiveNotice project={project} />}<ProjectViewNav projectId={project.id} current={view} />
    {/* keyでview切替ごとに作り直し、表示の切替を短いfadeで示す（reduced-motionでは動かさない）。 */}<div key={view} className="view-panel">
    {view === "overview" && <><p className="overview-mission"><span className="section-label">Mission</span> {project.mission}</p>{direction.access === "loading" ? <Loading /> : <ProjectOverview key={`${myRole ?? ""}/${direction.access}`} projectId={project.id} workspaceId={direction.workspaceId} archived={archived} permissions={permissions} />}<ClaimHolderSection projectId={project.id} /></>}
    {view === "direction" && <><section className="direction-panel"><div><p className="section-label">Mission</p><p>{project.mission}</p></div><div><p className="section-label">Vision</p><p>{project.vision ?? <span className="unset">未設定</span>}</p></div></section>{direction.workspaceId === null ? directionUnavailable : <IntentSection projectId={project.id} workspaceId={direction.workspaceId} access={directionAccess} />}<div className="detail-columns"><ListSection title="Principles" values={project.principles} /><ListSection title="Constraints" values={project.constraints} /></div></>}
    {view === "work" && <ExecutionSection projectId={project.id} />}
    {view === "records" && <><ActivitySection scope={{ kind: "project", projectId: project.id }} resources={[...project.repositories, ...project.resources]} />{direction.workspaceId === null ? directionUnavailable : <><ResearchSection projectId={project.id} workspaceId={direction.workspaceId} /><AdrReferenceSection workspaceId={direction.workspaceId} /></>}<LinkSection title="Repositories" values={project.repositories} /><LinkSection title="Resources" values={project.resources} /></>}
    {view === "settings" && <><AgentSettingsSection projectId={project.id} readOnly={grantReadOnly} showCredentials={canManageCredential} />{canManageCredential && <CredentialSection projectId={project.id} readOnly={archived} />}<MembershipSection key={myRole ?? ""} projectId={project.id} currentHumanId={session?.human.id ?? null} manage={canOperate(myRole, "member.manage")} readOnly={archived} onSelfChanged={() => void load().catch(showLoadError)} />{!archived && (canUpdate || canArchive) && <section className="detail-section" aria-labelledby="project-settings-heading"><h2 id="project-settings-heading">Project</h2><p className="section-note">名前・説明・Repository・Resourceの編集と、Projectのアーカイブです。Mission・Vision等は所属Workspaceのもので、Workspaceの概要からWorkspaceのadministratorが編集します。</p><div className="action-row">{canUpdate && <Link to={`/projects/${project.id}/edit`} className="button">Projectを編集</Link>}{canArchive && <button type="button" className="secondary-button danger" aria-expanded={archive.confirming} onClick={archive.open}>アーカイブ</button>}</div>{canArchive && archive.confirming && <ReasonPanel action={archive} title="このProjectをアーカイブしますか？" description="アーカイブすると、Projectの編集、Agent・RuntimeのRoleの割当の変更ができなくなります。内容と履歴は参照できます。所属Workspaceに他のactiveなProjectが無い場合はWorkspaceもアーカイブされ、Intent・Outcome等のDirectionも変更できなくなります。他にactiveなProjectがあれば、Directionは引き続き変更できます。" label={<>アーカイブの理由 <span>必須</span></>} required confirmLabel="アーカイブする" pendingLabel="アーカイブ中..." />}</section>}</>}
    </div></>}</main></Shell>;
};
