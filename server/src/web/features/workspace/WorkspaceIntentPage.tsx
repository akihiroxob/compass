import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { settle, type Part } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { LinkButton } from "../../components/ui";
import { workspaceIntentEditPath, workspacePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { IntentExplanationSection, IntentFacts, IntentMetricsSection, IntentRevisions, intentStatusLabels, useIntentPage, type Intent } from "../intent";
import { IntentOutcomeSummaries } from "../outcome";
import { pickOpenProject } from "../direction";
import type { Workspace } from "./workspace";
import { loadProjects, type OverviewProject } from "./workspaceProjects";

const GoalBody = ({ workspace, canEdit, intent, projects }: { workspace: Workspace; canEdit: boolean; intent: Intent; projects: Part<OverviewProject[]> }) => {
  const labels = projects.ok ? projects.value.map(({ project }) => ({ id: project.id, name: project.name })) : null;
  const openProject = projects.ok ? pickOpenProject([], projects.value.map(({ project }) => ({ id: project.id, status: project.status }))) : null;
  return (
    <>
      <nav className="breadcrumb" aria-label="現在位置"><ol><li><Link to={workspacePath(workspace.id)}>{workspace.name}</Link></li><li aria-current="page">ビジネス目標</li></ol></nav>
      <div className="detail-hero">
        <h1>{intent.title}</h1>
        {intent.status !== "active" && <p><span className={statusBadgeClass("muted")}>{intentStatusLabels[intent.status]}</span></p>}
        {canEdit && intent.status === "active" && <div className="action-row"><LinkButton variant="secondary" size="sm" to={workspaceIntentEditPath(workspace.id, intent.id)}>編集</LinkButton></div>}
      </div>
      <section className="detail-section" aria-label="目標の内容"><IntentFacts intent={intent} /><IntentRevisions workspaceId={workspace.id} intentId={intent.id} version={intent.version} /></section>
      <IntentMetricsSection workspaceId={workspace.id} intentId={intent.id} />
      <IntentExplanationSection projectId={openProject} workspaceId={workspace.id} intentId={intent.id} />
      <IntentOutcomeSummaries workspaceId={workspace.id} intentId={intent.id} projects={labels} />
      {!projects.ok && <p role="alert" className="error-title">Projectの名前を読み込めませんでした: {projects.error}</p>}
    </>
  );
};

/**
 * Workspaceのビジネス目標の詳細。背景・対象・制約などを全文で示し、観測値の日次の推移（7日／30日）・Agentの説明・関連Outcomeへ進める。
 * 値の無い期間・取得失敗・観測項目の未定義を、目標の達成・未達や0として扱わない。
 */
export const WorkspaceIntentContent = ({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) => {
  const { intentId = "" } = useParams();
  const { intent, error } = useIntentPage(workspace.id, intentId);
  const [projects, setProjects] = useState<Part<OverviewProject[]> | null>(null);
  useEffect(() => {
    let active = true;
    void settle(loadProjects(workspace.id), "Workspaceが見つかりません。").then((part) => { if (active) setProjects(part); });
    return () => { active = false; };
  }, [workspace.id]);
  if (error) return <><Link to={workspacePath(workspace.id)} className="back-link">← Workspace概要</Link><ErrorState message={error} /></>;
  if (!intent || !projects) return <Loading />;
  // URLのIntentが別のWorkspaceのものなら、serverが404を返して上のエラーになる。念のため画面側でも所属を確認する。
  if (intent.workspaceId !== workspace.id) return <ErrorState message="Intentが見つかりません。" />;
  return <GoalBody workspace={workspace} canEdit={canEdit} intent={intent} projects={projects} />;
};
