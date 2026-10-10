import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { classifyError, loadFailureMessage, jsonInit, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { ProjectOperationGate } from "../../components/ProjectOperationGate";
import { Shell } from "../../components/Shell";
import { formValuesFromProject, type Project } from "../../projectForm";
import { workspacePath } from "../workspace/workspace";
import { ProjectForm } from "./ProjectForm";

export const ProjectEditPage = () => { const { projectId = "" } = useParams(); return <ProjectOperationGate projectId={projectId} operation="project.update" back={{ to: `/projects/${projectId}`, label: "← Project詳細" }}><ProjectEditForm projectId={projectId} /></ProjectOperationGate>; };

const ProjectEditForm = ({ projectId }: { projectId: string }) => {
  const [project, setProject] = useState<Project | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ project: Project }>(`/api/projects/${projectId}`).then(({ project }) => setProject(project)).catch((reason: unknown) => setError(loadFailureMessage(classifyError(reason), "Projectが見つからないか、このProjectを閲覧する権限がありません。"))); }, [projectId]);
  if (error) return <Shell><main className="narrow"><Link to="/projects" className="back-link">← 参加中のProject</Link><ErrorState message={error} /></main></Shell>;
  if (!project) return <Shell><main className="narrow"><Loading /></main></Shell>;
  // Mission等は所属Workspaceの値で、Workspace Membershipのadministrator以上がWorkspaceの概要から編集する。
  return <ProjectForm initial={formValuesFromProject(project)} heading={{ eyebrow: "Edit project", title: "Projectを編集", lede: <>変更した内容は保存するまで反映されません。Mission・Vision・Principles・Constraintsは所属Workspaceのもので、<Link to={workspacePath(project.workspaceId)} className="text-link">Workspaceの概要</Link>から編集します。</> }} submitLabel="変更を保存" pendingLabel="保存中..." back={{ to: `/projects/${project.id}`, label: "Project詳細" }} archivedScope="Project" notFound="Projectが見つかりません。削除された可能性があります。" save={async (values) => (await request<{ project: Project }>(`/api/projects/${project.id}`, jsonInit("PATCH", values))).project} />;
};
