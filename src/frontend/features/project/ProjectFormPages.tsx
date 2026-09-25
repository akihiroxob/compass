import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { classifyError, jsonInit, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { ProjectOperationGate } from "../../components/ProjectOperationGate";
import { Shell } from "../../components/Shell";
import { emptyFormValues, formValuesFromProject, type Project } from "../../projectForm";
import { ProjectForm } from "./ProjectForm";

export const ProjectCreatePage = () => <ProjectForm initial={emptyFormValues} heading={{ eyebrow: "New project", title: "Projectを作成", lede: "必須なのは名前、Missionです。ほかの情報も今ここで整理できます。" }} submitLabel="Projectを作成" pendingLabel="作成中..." cancelTo="/" save={async (values) => (await request<{ project: Project }>("/api/projects", jsonInit("POST", values))).project} />;

export const ProjectEditPage = () => { const { projectId = "" } = useParams(); return <ProjectOperationGate projectId={projectId} operation="project.update" back={{ to: `/projects/${projectId}`, label: "← Project詳細" }}><ProjectEditForm projectId={projectId} /></ProjectOperationGate>; };

const ProjectEditForm = ({ projectId }: { projectId: string }) => {
  const [project, setProject] = useState<Project | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ project: Project }>(`/api/projects/${projectId}`).then(({ project }) => setProject(project)).catch((reason: unknown) => { const classified = classifyError(reason); setError(classified.kind === "not_found" ? "Projectが見つかりません。" : `読み込みに失敗しました: ${classified.kind === "other" ? classified.message : "入力内容が不正です"}`); }); }, [projectId]);
  if (error) return <Shell><main className="narrow"><Link to="/" className="back-link">← Project一覧</Link><ErrorState message={error} /></main></Shell>;
  if (!project) return <Shell><main className="narrow"><Loading /></main></Shell>;
  return <ProjectForm initial={formValuesFromProject(project)} heading={{ eyebrow: "Edit project", title: "Projectを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={`/projects/${project.id}`} save={async (values) => (await request<{ project: Project }>(`/api/projects/${project.id}`, jsonInit("PATCH", values))).project} />;
};
