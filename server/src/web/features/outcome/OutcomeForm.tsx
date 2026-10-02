import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError, fieldId } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Shell } from "../../components/Shell";
import { emptyCriterion, maxSuccessCriteria, type Outcome, type OutcomeFormValues } from "../../outcomeForm";
import { intentPath, outcomePath } from "../../paths";

type OutcomeFormProps = { projectId: string; intentId: string; mode: "create" | "edit"; initial: OutcomeFormValues; heading: { eyebrow: string; title: string; lede: string }; submitLabel: string; pendingLabel: string; cancelTo: string; save: (values: OutcomeFormValues) => Promise<Outcome> };

export const OutcomeForm = ({ projectId, intentId, mode, initial, heading, submitLabel, pendingLabel, cancelTo, save }: OutcomeFormProps) => {
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [hypothesis, setHypothesis] = useState(initial.hypothesis);
  const [rationale, setRationale] = useState(initial.rationale);
  const [criteria, setCriteria] = useState(initial.successCriteria);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const updateCriterion = (index: number, changes: Partial<(typeof criteria)[number]>) => setCriteria(criteria.map((item, i) => i === index ? { ...item, ...changes } : item));
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const outcome = await save({ title, description, hypothesis, rationale, successCriteria: criteria }); navigate(outcomePath(projectId, intentId, outcome.id)); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "not_found" ? { kind: "other", message: "Project、Intent、またはOutcomeが見つかりません。削除された可能性があります。" } : classified); } finally { setIsSubmitting(false); } };
  return <Shell><main className="narrow"><Link to={cancelTo} className="back-link">← 戻る</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>
    {error && <FormErrorSummary error={error} projectDetailTo={`/projects/${projectId}`} conflict={{ title: "この操作は現在のIntentまたはOutcomeの状態と競合しています。", action: <Link to={intentPath(projectId, intentId)} className="text-link">Intentを開く →</Link> }} />}
    <form onSubmit={submit} className="project-form"><section className="form-section"><label>タイトル <span>必須</span><small>Outcomeを一言で表す名前（100文字まで）</small><input {...fieldProps(invalid, "field-title")} required aria-required="true" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      {mode === "create" && <><label>達成すべき状態 <span>必須</span><small>Intentへ近づくために達成すべき、観測可能な状態。作成後は変更できません。</small><textarea {...fieldProps(invalid, "field-description")} required aria-required="true" maxLength={2000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} /></label></>}
      <label>仮説<small>これを達成するとIntentへ近づくと考える理由（任意）</small><textarea {...fieldProps(invalid, "field-hypothesis")} maxLength={2000} rows={3} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} /></label>
      {mode === "create" && <label>判断理由（Strategistの判断） <span>必須</span><small>Strategist（またはHuman）が、なぜこのOutcomeを今選んだか。判断の記録として作成後は変更できません。</small><textarea {...fieldProps(invalid, "field-rationale")} required aria-required="true" maxLength={2000} rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>}</section>
    {mode === "create" ? <section className="form-section"><h2>成功条件</h2><p className="fixed-note">成功条件は作成時に固定され、後から編集できません。変更する場合は、このOutcomeを取り消して新しいOutcomeを作成します。1〜{maxSuccessCriteria}件。</p>
      <fieldset className="repeat-field" {...fieldProps(invalid, "field-successCriteria")}><legend className="visually-hidden">成功条件の一覧</legend>{criteria.map((criterion, index) => <fieldset className="criterion-row" key={index}><legend>成功条件 {index + 1}</legend>
        <label>内容 <span>必須</span><small>何を満たせば成功か（例: duplicate_claim_count = 0）</small><input {...fieldProps(invalid, fieldId(`successCriteria.${index}.description`))} required aria-required="true" maxLength={500} value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} /></label>
        <label>測定方法 <span>必須</span><small>どう観測し、どの証拠があれば成立と言えるか。「できた」という主張だけでは成立にできません。</small><textarea {...fieldProps(invalid, fieldId(`successCriteria.${index}.measurement`))} required aria-required="true" maxLength={1000} rows={3} value={criterion.measurement} onChange={(event) => updateCriterion(index, { measurement: event.target.value })} /></label>
        <label>目標値<small>任意（例: = 0、100%）</small><input {...fieldProps(invalid, fieldId(`successCriteria.${index}.target`))} maxLength={200} value={criterion.target} onChange={(event) => updateCriterion(index, { target: event.target.value })} /></label>
        <button type="button" className="remove" disabled={criteria.length <= 1} aria-label={`成功条件 ${index + 1}を削除`} onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}>この成功条件を削除</button></fieldset>)}
        <button type="button" className="add-row" disabled={criteria.length >= maxSuccessCriteria} onClick={() => setCriteria([...criteria, emptyCriterion])}>＋ 成功条件を追加</button></fieldset></section> : <p className="fixed-note">達成すべき状態・判断理由・成功条件は作成時に固定されており、編集できるのはタイトルと仮説だけです。</p>}
    <div className="form-actions"><Link to={cancelTo} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};
