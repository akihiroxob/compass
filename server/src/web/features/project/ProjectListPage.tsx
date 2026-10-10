import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import type { Project } from "../../projectForm";
import { parseListStatus, projectListPath, projectsApiPath, summarizeReason, type ProjectStatus } from "../../projectArchive";

/** Project一覧のActive・アーカイブ済みの切替。`pathOf`は一覧ごとのURL（参加中のProject・WorkspaceのProject）。 */
export const ProjectListSwitch = ({ status, pathOf = projectListPath }: { status: ProjectStatus; pathOf?: (status: ProjectStatus) => string }) => (
  <nav className="list-switch" aria-label="Projectの表示切替">
    <Link to={pathOf("active")} aria-current={status === "active" ? "page" : undefined}>Active</Link>
    <Link to={pathOf("archived")} aria-current={status === "archived" ? "page" : undefined}>アーカイブ済み</Link>
  </nav>
);

/**
 * 参加中のProject。Project Membershipを持つProjectを、Workspaceをまたいで一覧する。
 * Workspace Membershipの無いProjectにもここから辿れる（Workspace Selectorの一覧には出ない）。
 */
export const ProjectListPage = () => {
  const status = parseListStatus(useSearchParams()[0].get("status"));
  const [state, setState] = useState<{ status: ProjectStatus; projects: Project[] | null; error: string | null }>({ status, projects: null, error: null });
  useEffect(() => {
    let current = true;
    request<{ projects: Project[] }>(projectsApiPath(status))
      .then(({ projects }) => current && setState({ status, projects, error: null }))
      .catch((reason: unknown) => { current && setState({ status, projects: null, error: loadFailureMessage(classifyError(reason), "Projectの一覧が見つかりません。") }); });
    return () => { current = false; };
  }, [status]);
  // 切替直後は、前の一覧を出さずに読み込み中を表示する。
  const { projects, error } = state.status === status ? state : { projects: null, error: null };
  return <Shell><main><div className="page-heading"><div><p className="eyebrow">Projects</p><h1>参加中のProject</h1></div><Link to="/projects/new" className="button">Projectを作成</Link></div><p className="lede">Membershipを持つProjectを、Workspaceをまたいで表示します。Workspaceごとの一覧はWorkspaceの「Project」から開けます。</p>
    <ProjectListSwitch status={status} />
    {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : projects === null ? <Loading /> : projects.length === 0 ? (status === "archived" ? <div className="state-card"><h2>アーカイブ済みのProjectはありません</h2><p>アーカイブしたProjectは、ここから理由と履歴を参照できます。</p></div> : <div className="state-card"><h2>最初のProjectを作成しましょう</h2><p>この現場が存在する理由から始めます。</p><Link to="/projects/new" className="text-link">作成フォームを開く →</Link></div>) : <section className="project-grid" aria-label={`${projects.length}件のProject`}>{projects.map((project) => <Link className="project-card" to={`/projects/${project.id}`} key={project.id}><p className="card-label">Project</p><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}<div className="mission-preview"><span>Mission</span>{project.mission}</div>{project.status === "archived" && <div className="mission-preview archive-preview"><span>アーカイブの理由</span>{summarizeReason(project.archiveReason)}</div>}<time>{project.status === "archived" && project.archivedAt !== null ? `${new Date(project.archivedAt).toLocaleDateString("ja-JP")} アーカイブ` : `${new Date(project.updatedAt).toLocaleDateString("ja-JP")} 更新`}</time></Link>)}</section>}
  </main></Shell>;
};
