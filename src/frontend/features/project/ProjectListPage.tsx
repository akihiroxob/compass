import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import type { Project } from "../../projectForm";

export const ProjectListPage = () => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ projects: Project[] }>("/api/projects").then(({ projects }) => setProjects(projects)).catch((reason: unknown) => { const classified = classifyError(reason); setError(classified.kind === "other" ? classified.message : "不明なエラー"); }); }, []);
  return <Shell><main><div className="page-heading"><div><p className="eyebrow">Projects</p><h1>進む理由を、見失わない。</h1></div><Link to="/projects/new" className="button">Projectを作成</Link></div><p className="lede">MissionとVisionを軸に、判断の原則・制約・参照先をひとつの場所にまとめます。</p>
    {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : projects === null ? <Loading /> : projects.length === 0 ? <div className="state-card"><h2>最初のProjectを作成しましょう</h2><p>この現場が存在する理由から始めます。</p><Link to="/projects/new" className="text-link">作成フォームを開く →</Link></div> : <section className="project-grid" aria-label={`${projects.length}件のProject`}>{projects.map((project) => <Link className="project-card" to={`/projects/${project.id}`} key={project.id}><p className="card-label">Project</p><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}<div className="mission-preview"><span>Mission</span>{project.mission}</div><time>{new Date(project.updatedAt).toLocaleDateString("ja-JP")} 更新</time></Link>)}</section>}
  </main></Shell>;
};
