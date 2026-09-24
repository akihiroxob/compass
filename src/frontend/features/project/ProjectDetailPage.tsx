import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { classifyError, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import type { Project } from "../../projectForm";
import { archiveInit, archiveProjectPath, describeArchiveFailure, projectListPath, projectStatusLabels, validateArchiveReason } from "../../projectArchive";
import { AdrReferenceSection } from "../adr";
import { GrantSection } from "../grant";
import { IntentSection } from "../intent";
import { ResearchSection } from "../research";

const ListSection = ({ title, values }: { title: string; values: string[] }) => <section className="detail-section"><h2>{title}</h2>{values.length ? <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul> : <p className="unset">未設定</p>}</section>;
const LinkSection = ({ title, values }: { title: string; values: ({ id: string; name: string; url: string; kind?: string | null })[] }) => <section className="detail-section"><h2>{title}</h2>{values.length ? <div className="link-list">{values.map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={item.id}><span>{item.name}</span><small>{item.kind || item.url}</small></a>)}</div> : <p className="unset">未設定</p>}</section>;

/** 状態・理由・日時。archivedのProjectだけに出し、復帰できるかのような文言は置かない。 */
const ArchiveNotice = ({ project }: { project: Project }) => <section className="detail-section archive-notice" aria-labelledby="archive-heading"><h2 id="archive-heading"><span className="status-badge muted">{projectStatusLabels.archived}</span> このProjectはアーカイブされています</h2><p className="section-note">参照のみできます。Projectの編集、IntentやOutcomeの登録・変更、Agent・RuntimeのRoleの割当の変更はできません。</p><dl className="intent-facts"><dt>アーカイブの理由</dt><dd>{project.archiveReason ?? <span className="unset">理由は記録されていません</span>}</dd><dt>アーカイブした日時</dt><dd>{project.archivedAt === null ? <span className="unset">記録されていません</span> : new Date(project.archivedAt).toLocaleString("ja-JP")}</dd></dl></section>;

export const ProjectDetailPage = () => {
  const { projectId = "" } = useParams(); const [project, setProject] = useState<Project | null>(null); const [error, setError] = useState<string | null>(null);
  const load = () => request<{ project: Project }>(`/api/projects/${projectId}`).then(({ project }) => setProject(project));
  useEffect(() => { load().catch((reason: unknown) => { const classified = classifyError(reason); setError(classified.kind === "not_found" ? "Projectが見つかりません。" : `読み込みに失敗しました: ${classified.kind === "other" ? classified.message : "入力内容が不正です"}`); }); }, [projectId]);
  const archive = useReasonAction(async (reason) => {
    const invalid = validateArchiveReason(reason);
    if (invalid) throw new Error(invalid);
    try { setProject((await request<{ project: Project }>(archiveProjectPath(projectId), archiveInit(reason))).project); } catch (failure) {
      // 他の操作で既にアーカイブされていた場合は、表示を最新（アーカイブ済み）へ揃えてから失敗を表示する。
      if (classifyError(failure).kind === "project_archived") await load().catch(() => undefined);
      throw failure;
    }
  }, describeArchiveFailure);
  const archived = project?.status === "archived";
  return <Shell><main className="narrow"><Link to="/" className="back-link">← Project一覧</Link>{archived && <> <Link to={projectListPath("archived")} className="back-link">アーカイブ済み一覧</Link></>}{error ? <ErrorState message={error} /> : !project ? <Loading /> : <><div className="detail-hero"><p className="eyebrow">Project</p><h1>{project.name}</h1>{archived && <p><span className="status-badge muted">{projectStatusLabels.archived}</span></p>}{project.description && <p className="lede">{project.description}</p>}<time>{new Date(project.updatedAt).toLocaleString("ja-JP")} 更新</time>{!archived && <div className="action-row"><Link to={`/projects/${project.id}/edit`} className="button">Projectを編集</Link><button type="button" className="secondary-button danger" aria-expanded={archive.confirming} onClick={archive.open}>アーカイブ</button></div>}</div>{!archived && archive.confirming && <ReasonPanel action={archive} title="このProjectをアーカイブしますか？" description="アーカイブすると、Projectの編集、IntentやOutcomeの登録・変更、Agent・RuntimeのRoleの割当の変更ができなくなります。内容と履歴は参照できます。" label={<>アーカイブの理由 <span>必須</span></>} required confirmLabel="アーカイブする" pendingLabel="アーカイブ中..." />}{archived && <ArchiveNotice project={project} />}<section className="direction-panel"><div><p className="section-label">Mission</p><p>{project.mission}</p></div><div><p className="section-label">Vision</p><p>{project.vision ?? <span className="unset">未設定</span>}</p></div></section><IntentSection projectId={project.id} readOnly={archived} /><GrantSection projectId={project.id} role="strategist" readOnly={archived} description={<>Agent名はMCPの <code>Authorization: Bearer &lt;AgentName&gt;</code> に設定する名前です。Strategistの割当はAgentを起動しません。API・CLIでも同じ操作ができ、この画面は任意の入口です。</>} /><GrantSection projectId={project.id} role="researcher" readOnly={archived} description={<>Research Requestの調査結果を登録するAgentです。Researcherの割当はAgentを起動しません。API・CLIでも同じ操作ができ、この画面は任意の入口です。</>} /><GrantSection projectId={project.id} role="manager" readOnly={archived} description={<>確定したOutcomeをStory・Taskへ落とし込み、最終受入するAgentです。Managerの割当はAgentを起動しません。</>} /><GrantSection projectId={project.id} role="worker" readOnly={archived} description={<>Taskを引き受けて実装するAgentです。Workerの割当はAgentを起動しません。</>} /><GrantSection projectId={project.id} role="reviewer" readOnly={archived} description={<>完了したTaskを実装・検証の観点でレビューするAgentです。Reviewerの割当はAgentを起動しません。</>} /><GrantSection projectId={project.id} role="evaluator" readOnly={archived} description={<>Outcomeの固定Success Criteriaを、還流したExecution Evidenceで評価するAgentです。Evaluatorの割当はAgentを起動しません。</>} /><GrantSection projectId={project.id} role="runtime" readOnly={archived} description={<>Runtimeイベントを取得・ackし、Agentを起動する外部Runtimeの名前です（暫定。Runtime用Credentialへ置き換える予定）。Runtimeの割当はRuntimeやAgentを起動しません。</>} /><ResearchSection projectId={project.id} /><AdrReferenceSection projectId={project.id} /><div className="detail-columns"><ListSection title="Principles" values={project.principles} /><ListSection title="Constraints" values={project.constraints} /></div><LinkSection title="Repositories" values={project.repositories} /><LinkSection title="Resources" values={project.resources} /></>}</main></Shell>;
};
