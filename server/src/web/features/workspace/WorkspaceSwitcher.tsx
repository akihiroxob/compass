import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { Button, Select } from "../../components/ui";
import { projectMenuViews, projectViewPath, workspaceApiPath, workspaceCreatePath, workspacePath, workspaceProjectCreatePath, workspaceProjectsPath } from "../../paths";
import { canOperateWorkspace } from "../access";
import type { HumanRole } from "../member";
import { projectViewLabels } from "../project";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import { currentSection, workspaceMenuSections, workspaceSectionLabels, type WorkspaceProject } from "./workspace";
import { loadProjects } from "./workspaceProjects";

/**
 * Workspace Selector（メニューの先頭のSelect）。選択肢はWorkspace Membershipを持つactiveなWorkspaceと、
 * 一覧に無い現在のWorkspace（archived）。選ぶと切替先のWorkspaceの概要を開き、元の画面の項目を持ち越さない。
 */
export const WorkspaceSwitcher = () => {
  const navigation = useWorkspaceNavigation();
  const navigate = useNavigate();
  if (!navigation) return null;
  const { workspaces, error, reload, current, currentId, resolving } = navigation;
  if (error) {
    return (
      <div className="workspace-switch-error" role="alert">
        <span>Workspaceの一覧を読み込めませんでした</span>
        <Button variant="secondary" size="sm" onClick={reload}>再試行</Button>
      </div>
    );
  }
  if (workspaces !== null && workspaces.length === 0 && current === null) return <Link to={workspaceCreatePath} className="text-link">Workspaceを作成</Link>;
  const loading = workspaces === null || (resolving && current === null);
  const options = workspaces === null ? [] : current && !workspaces.some(({ id }) => id === current.id) ? [...workspaces, current] : workspaces;
  return (
    <Select aria-label="Workspaceを切り替える" value={loading ? "" : current?.id ?? ""} disabled={loading} onChange={(event) => navigate(workspacePath(event.target.value))}>
      {loading ? <option value="">読み込み中...</option> : current === null && <option value="" disabled>{currentId === null ? "Workspaceを選択" : "閲覧できないWorkspace"}</option>}
      {options.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}{workspace.status === "archived" ? "（アーカイブ済み）" : ""}</option>)}
    </Select>
  );
};

/**
 * Workspaceのメニュー（概要 → 対応待ち → Outcome → Activity → Agent管理 → 設定）。現在のWorkspaceを閲覧できる場合だけ出す。
 * 各項目はURLを持つ画面へのリンクで、選択中に`aria-current="page"`。
 */
export const WorkspaceNav = () => {
  const navigation = useWorkspaceNavigation();
  if (!navigation?.current) return null;
  const { current, location } = navigation;
  const active = currentSection(location);
  return (
    <nav className="workspace-nav" aria-label={`Workspace ${current.name}`}>
      <ul>
        {workspaceMenuSections.map((section) => (
          <li key={section}>
            <Link to={workspacePath(current.id, section)} aria-current={section === active ? "page" : undefined}>{workspaceSectionLabels[section]}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
};

type ProjectMenu = { key: string; projects: WorkspaceProject[] | null; canCreate: boolean; error: string | null };

/**
 * メニューの「Project」。現在のWorkspaceのactiveなProject（開いているProjectがarchivedならそれも）を並べ、選ぶと切替先の概要を開く。
 * 開いているProjectの下へ、概要・開発詳細・リリース履歴・設定を一段下げて並べる。Project追加（＋）はProjectを作成できるRoleだけに出す。
 * 導線の表示の判定であり、拒否は常にserverが行う。
 */
export const WorkspaceProjectNav = () => {
  const navigation = useWorkspaceNavigation();
  const workspace = navigation?.current ?? null;
  const location = navigation?.location ?? { kind: "none" as const };
  const projectId = location.kind === "project" ? location.projectId : null;
  const [menu, setMenu] = useState<ProjectMenu | null>(null);
  const [revision, setRevision] = useState(0);
  // Projectを開く・切り替える・view（編集の後を含む）を移るたびに取り直し、作成直後のProjectや変更した名前を反映する。
  const key = workspace ? `${workspace.id}#${revision}#${projectId ?? ""}#${location.kind === "project" ? location.view ?? "" : ""}` : null;
  useEffect(() => {
    if (workspace === null || key === null) return;
    let active = true;
    Promise.all([loadProjects(workspace.id), request<{ myRole: HumanRole }>(workspaceApiPath(workspace.id))])
      .then(([projects, { myRole }]) => {
        if (active) setMenu({ key, projects: projects.map(({ project }) => project), canCreate: workspace.status === "active" && canOperateWorkspace(myRole, "project.create"), error: null });
      })
      .catch((reason: unknown) => { if (active) setMenu({ key, projects: null, canCreate: false, error: loadFailureMessage(classifyError(reason), "Projectの一覧が見つかりません。") }); });
    return () => { active = false; };
  }, [key]);
  if (workspace === null) return null;
  // 取り直し中も前の一覧を出し、メニューの位置を動かさない。別のWorkspaceの一覧は出さない。
  const loaded = menu?.key.startsWith(`${workspace.id}#`) ? menu : null;
  const shown = loaded?.projects?.filter((project) => project.status === "active" || project.id === projectId) ?? [];
  return (
    <nav className="project-nav" aria-label="Project">
      <div className="project-nav-heading">
        <span>Project</span>
        {loaded?.canCreate && <Link to={workspaceProjectCreatePath(workspace.id)} className="project-nav-add" aria-label="Projectを追加">＋</Link>}
      </div>
      {loaded?.error ? (
        <div className="project-nav-note" role="alert">
          <span>Projectの一覧を読み込めませんでした: {loaded.error}</span>
          <Button variant="secondary" size="sm" onClick={() => setRevision((value) => value + 1)}>再試行</Button>
        </div>
      ) : !loaded?.projects ? (
        <p className="project-nav-note" role="status">読み込み中...</p>
      ) : shown.length === 0 ? (
        <p className="project-nav-note">Projectはありません</p>
      ) : (
        <ul>
          {shown.map((project) => (
            <li key={project.id}>
              <Link to={projectViewPath(project.id, "overview")} aria-current={project.id === projectId ? "location" : undefined}>
                <span>{project.name}</span>
                {project.status === "archived" && <small>アーカイブ済み</small>}
              </Link>
              {project.id === projectId && (
                <ul>
                  {projectMenuViews.map((view) => (
                    <li key={view}>
                      <Link to={projectViewPath(project.id, view)} aria-current={location.kind === "project" && location.view === view ? "page" : undefined}>{projectViewLabels[view]}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
};

/**
 * Project配下の画面のパンくずの先頭（Workspace → Project一覧）。Projectの所属Workspaceが現在のWorkspaceとして閲覧できる場合だけ出す。
 * 親の`<ol>`に置く`<li>`を返す。
 */
export const WorkspaceBreadcrumbItems = ({ project }: { project: { workspaceId: string; status: "active" | "archived" } }) => {
  const navigation = useWorkspaceNavigation();
  const workspace = navigation?.current?.id === project.workspaceId ? navigation.current : null;
  if (!workspace) return null;
  return (
    <>
      <li><Link to={workspacePath(workspace.id)}>{workspace.name}</Link></li>
      <li><Link to={workspaceProjectsPath(workspace.id, project.status)}>Project</Link></li>
    </>
  );
};
