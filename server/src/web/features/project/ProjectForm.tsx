import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { LinkListInput } from "../../components/ListInputs";
import { Shell } from "../../components/Shell";
import type { Project, ProjectFormValues } from "../../projectForm";

type ProjectFormProps = {
  initial: ProjectFormValues;
  heading: { eyebrow: string; title: string; lede: ReactNode };
  submitLabel: string;
  pendingLabel: string;
  /** 戻り先とキャンセル先。archivedで拒否された場合の詳細への導線にも使う。 */
  back: { to: string; label: string };
  /** archivedで拒否される対象。既存WorkspaceへのProject作成はWorkspace。 */
  archivedScope: "Project" | "Workspace";
  notFound: string;
  save: (values: ProjectFormValues) => Promise<Project>;
};

/** Projectの作成（Workspaceへの追加）・編集フォーム。Mission等は所属Workspaceが所有し、Workspaceの編集で扱う。 */
export const ProjectForm = ({ initial, heading, submitLabel, pendingLabel, back, archivedScope, notFound, save }: ProjectFormProps) => {
  const navigate = useNavigate();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [repositories, setRepositories] = useState(initial.repositories);
  const [resources, setResources] = useState(initial.resources);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const project = await save({ name, description, repositories, resources }); navigate(`/projects/${project.id}`); } catch (reason) { setError(withNotFoundMessage(classifyError(reason), notFound)); } finally { setIsSubmitting(false); } };
  return <Shell><main className="narrow"><Link to={back.to} className="back-link">← {back.label}</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>{error && <FormErrorSummary error={error} detailTo={back.to} archivedScope={archivedScope} />}<form onSubmit={submit} className="project-form">
    <section className="form-section"><h2>Identity</h2><label>Project名 <span>必須</span><input {...fieldProps(invalid, "field-name")} required aria-required="true" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label><label>説明<small>このProjectが担う実行の範囲</small><textarea {...fieldProps(invalid, "field-description")} maxLength={1000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label></section>
    <section className="form-section"><h2>References</h2><LinkListInput legend="Repositories" name="repositories" invalid={invalid} values={repositories} setValues={setRepositories} /><LinkListInput legend="Resources" name="resources" invalid={invalid} values={resources} setValues={setResources} withKind /></section>
    <div className="form-actions"><Link to={back.to} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};
