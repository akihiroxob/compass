import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { classifyError, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import type { Project } from "../../projectForm";
import { parseListStatus, projectListPath, projectsApiPath, summarizeReason, type ProjectStatus } from "../../projectArchive";

const ListSwitch = ({ status }: { status: ProjectStatus }) => (
  <nav className="list-switch" aria-label="Projectの表示切替">
    <Link to={projectListPath("active")} aria-current={status === "active" ? "page" : undefined}>Active</Link>
    <Link to={projectListPath("archived")} aria-current={status === "archived" ? "page" : undefined}>アーカイブ済み</Link>
  </nav>
);

export const ProjectListPage = () => {
  const status = parseListStatus(useSearchParams()[0].get("status"));
  const [state, setState] = useState<{ status: ProjectStatus; projects: Project[] | null; error: string | null }>({ status, projects: null, error: null });
  useEffect(() => {
    let current = true;
    request<{ projects: Project[] }>(projectsApiPath(status))
      .then(({ projects }) => current && setState({ status, projects, error: null }))
      .catch((reason: unknown) => { const classified = classifyError(reason); current && setState({ status, projects: null, error: classified.kind === "other" ? classified.message : "不明なエラー" }); });
    return () => { current = false; };
  }, [status]);
  // 切替直後は、前の一覧を出さずに読み込み中を表示する。
  const { projects, error } = state.status === status ? state : { projects: null, error: null };
  return <Shell><main><div className="page-heading"><div><p className="eyebrow">Projects</p><h1>進む理由を、見失わない。</h1></div><Link to="/projects/new" className="button">Projectを作成</Link></div><p className="lede">MissionとVisionを軸に、判断の原則・制約・参照先をひとつの場所にまとめます。</p>
    <ListSwitch status={status} />
    {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : projects === null ? <Loading /> : projects.length === 0 ? (status === "archived" ? <div className="state-card"><h2>アーカイブ済みのProjectはありません</h2><p>アーカイブしたProjectは、ここから理由と履歴を参照できます。</p></div> : <div className="state-card"><h2>最初のProjectを作成しましょう</h2><p>この現場が存在する理由から始めます。</p><Link to="/projects/new" className="text-link">作成フォームを開く →</Link></div>) : <section className="project-grid" aria-label={`${projects.length}件のProject`}>{projects.map((project) => <Link className="project-card" to={`/projects/${project.id}`} key={project.id}><p className="card-label">Project</p><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}<div className="mission-preview"><span>Mission</span>{project.mission}</div>{project.status === "archived" && <div className="mission-preview archive-preview"><span>アーカイブの理由</span>{summarizeReason(project.archiveReason)}</div>}<time>{project.status === "archived" && project.archivedAt !== null ? `${new Date(project.archivedAt).toLocaleDateString("ja-JP")} アーカイブ` : `${new Date(project.updatedAt).toLocaleDateString("ja-JP")} 更新`}</time></Link>)}</section>}
  </main></Shell>;
};
