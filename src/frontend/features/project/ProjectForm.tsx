import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Shell } from "../../components/Shell";
import type { Project, ProjectFormValues } from "../../projectForm";
import { LinkListInput, TextListInput } from "./ListInputs";

type ProjectFormProps = { initial: ProjectFormValues; heading: { eyebrow: string; title: string; lede: string }; submitLabel: string; pendingLabel: string; cancelTo: string; save: (values: ProjectFormValues) => Promise<Project> };

export const ProjectForm = ({ initial, heading, submitLabel, pendingLabel, cancelTo, save }: ProjectFormProps) => {
  const navigate = useNavigate();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [mission, setMission] = useState(initial.mission);
  const [vision, setVision] = useState(initial.vision);
  const [principles, setPrinciples] = useState(initial.principles);
  const [constraints, setConstraints] = useState(initial.constraints);
  const [repositories, setRepositories] = useState(initial.repositories);
  const [resources, setResources] = useState(initial.resources);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const project = await save({ name, description, mission, vision, principles, constraints, repositories, resources }); navigate(`/projects/${project.id}`); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "validation" || classified.kind === "project_archived" ? classified : { kind: "other", message: classified.kind === "other" ? classified.message : "Projectが見つかりません。削除された可能性があります。" }); } finally { setIsSubmitting(false); } };
  return <Shell><main className="narrow"><Link to={cancelTo} className="back-link">← {cancelTo === "/" ? "Project一覧" : "Project詳細"}</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>{error && <FormErrorSummary error={error} projectDetailTo={cancelTo === "/" ? undefined : cancelTo} />}<form onSubmit={submit} className="project-form">
    <section className="form-section"><h2>Identity</h2><label>Project名 <span>必須</span><input {...fieldProps(invalid, "field-name")} required aria-required="true" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label><label>説明<textarea {...fieldProps(invalid, "field-description")} maxLength={1000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label></section>
    <section className="form-section"><h2>Direction</h2><label>Mission <span>必須</span><small>このProjectが存在する理由</small><textarea {...fieldProps(invalid, "field-mission")} required aria-required="true" maxLength={2000} rows={5} value={mission} onChange={(event) => setMission(event.target.value)} /></label><label>Vision<small>最終的に実現したい状態</small><textarea {...fieldProps(invalid, "field-vision")} maxLength={2000} rows={5} value={vision} onChange={(event) => setVision(event.target.value)} /></label><TextListInput legend="Principles" name="principles" invalid={invalid} values={principles} setValues={setPrinciples} placeholder="迷ったときの判断原則" /><TextListInput legend="Constraints" name="constraints" invalid={invalid} values={constraints} setValues={setConstraints} placeholder="超えてはいけない制約" /></section>
    <section className="form-section"><h2>References</h2><LinkListInput legend="Repositories" name="repositories" invalid={invalid} values={repositories} setValues={setRepositories} /><LinkListInput legend="Resources" name="resources" invalid={invalid} values={resources} setValues={setResources} withKind /></section>
    <div className="form-actions"><Link to={cancelTo} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};
