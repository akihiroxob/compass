import { useState, type FormEvent } from "react";
import { classifyError, jsonInit, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { LinkListInput } from "../../components/ListInputs";
import { Button, Field, TextArea, TextInput } from "../../components/ui";
import { formValuesFromProject, withDerivedNames, type Project } from "./project";

/**
 * Project設定の基本情報・Repository・Resource。Mission等は所属Workspaceのものでここへ複製しない。
 * `readOnly`（閲覧者・archive）では保存済みの内容を参照だけでき、変更できない理由を示す。
 * 保存に失敗しても入力stateを維持し、そのまま再送信できる。保存成功時は保存結果（新しいid・更新時刻）で入力を更新し、「保存しました」を残す。
 */
export const ProjectSettingsSection = ({ project, readOnly, readOnlyReason, onSaved }: { project: Project; readOnly: boolean; readOnlyReason: string; onSaved: (project: Project) => void }) => {
  const initial = formValuesFromProject(project);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [repositories, setRepositories] = useState(initial.repositories);
  const [resources, setResources] = useState(initial.resources);
  const [error, setError] = useState<FormError | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setSaved(false); setIsSubmitting(true);
    try { const { project: next } = await request<{ project: Project }>(`/api/projects/${project.id}`, jsonInit("PATCH", { name, description, repositories: withDerivedNames(repositories), resources, expectedUpdatedAt: project.updatedAt })); const values = formValuesFromProject(next); setName(values.name); setDescription(values.description); setRepositories(values.repositories); setResources(values.resources); setSaved(true); onSaved(next); }
    catch (reason) { setError(withNotFoundMessage(classifyError(reason), "Projectが見つかりません。")); }
    finally { setIsSubmitting(false); }
  };
  return <section className="detail-section" aria-labelledby="project-basic-heading"><h2 id="project-basic-heading">基本情報・Repository・Resource</h2>
    <p className="section-note">{readOnly ? readOnlyReason : "変更した内容は保存するまで反映されません。Mission・Vision等は所属Workspaceのもので、Workspaceの設定から編集します。"}</p>
    {error && <FormErrorSummary error={error} conflict={{ title: "保存が競合しました。入力内容は残っています" }} detailTo={`/projects/${project.id}?view=settings`} archivedScope="Project" />}
    {saved && !error && !readOnly && <p role="status" className="section-note">保存しました。</p>}
    <form onSubmit={submit} className="project-form">
      <section className="form-section"><Field label="Project名" required><TextInput {...fieldProps(invalid, "field-name")} readOnly={readOnly} required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="説明" description="このProjectが担う実行の範囲"><TextArea {...fieldProps(invalid, "field-description")} readOnly={readOnly} maxLength={1000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field></section>
      <section className="form-section"><LinkListInput legend="Repositories" name="repositories" invalid={invalid} values={repositories} setValues={setRepositories} withName={false} readOnly={readOnly} /><LinkListInput legend="Resources" name="resources" invalid={invalid} values={resources} setValues={setResources} withKind readOnly={readOnly} /></section>
      {!readOnly && <div className="form-actions"><Button type="submit" pending={isSubmitting}>{isSubmitting ? "保存中..." : "変更を保存"}</Button></div>}
    </form></section>;
};
