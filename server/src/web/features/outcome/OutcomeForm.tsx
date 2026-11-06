import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError, fieldId } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Button, Field, LinkButton, TextArea, TextInput } from "../../components/ui";
import { emptyCriterion, maxOutcomeProblems, maxSuccessCriteria, type Outcome, type OutcomeFormValues } from "./outcome";
import { ProblemFields } from "./ProblemFields";
import { useEvidenceOptions } from "./useEvidenceOptions";

type OutcomeFormProps = {
  workspaceId: string;
  mode: "create" | "edit";
  initial: OutcomeFormValues;
  heading: { eyebrow: string; title: string; lede: string };
  submitLabel: string;
  pendingLabel: string;
  cancelTo: string;
  save: (values: OutcomeFormValues) => Promise<Outcome>;
  /** 保存後に開く画面。 */
  savedTo: (outcome: Outcome) => string;
  /** archived等で拒否されたときに内容を確認できる画面。 */
  detailTo: string;
  /** 競合（状態・版）のときの導線。 */
  conflictAction: ReactNode;
};

/**
 * Outcomeの作成・編集フォーム。目指す変化・判断理由・成功条件は作成時に固定し、編集ではタイトル・貢献仮説・課題を変更する
 * （契約はserverの`outcomeSchema`、MCPと共通）。課題は一覧全体を保存し、表示後に他で更新されていれば競合として拒否される。
 */
export const OutcomeForm = ({ workspaceId, mode, initial, heading, submitLabel, pendingLabel, cancelTo, save, savedTo, detailTo, conflictAction }: OutcomeFormProps) => {
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [hypothesis, setHypothesis] = useState(initial.hypothesis);
  const [rationale, setRationale] = useState(initial.rationale);
  const [criteria, setCriteria] = useState(initial.successCriteria);
  const [problems, setProblems] = useState(initial.problems);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const evidenceOptions = useEvidenceOptions(workspaceId);
  const invalid = invalidFieldIds(error);
  const updateCriterion = (index: number, changes: Partial<(typeof criteria)[number]>) => setCriteria(criteria.map((item, i) => i === index ? { ...item, ...changes } : item));
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const outcome = await save({ title, description, hypothesis, rationale, successCriteria: criteria, problems }); navigate(savedTo(outcome)); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "not_found" ? { kind: "other", message: "Workspace、Intent、またはOutcomeが見つかりません。削除されたか、閲覧する権限がありません。" } : classified); } finally { setIsSubmitting(false); } };
  return <main className="narrow"><Link to={cancelTo} className="back-link">← 戻る</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>
    {error && <FormErrorSummary error={error} detailTo={detailTo} archivedScope="Workspace" conflict={{ title: "この操作は現在のIntentまたはOutcomeの状態と競合しています。", action: conflictAction }} />}
    <form onSubmit={submit} className="project-form"><section className="form-section"><Field label="Outcome名" required description="Outcomeを一言で表す名前（100文字まで）"><TextInput {...fieldProps(invalid, "field-title")} required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
      {mode === "create" && <Field label="目指す変化" required description="目標へ近づくために実現する、観測可能な変化。作成後は変更できません。"><TextArea {...fieldProps(invalid, "field-description")} required maxLength={2000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>}
      <Field label="目標への貢献仮説" description="この変化が実現するとビジネス目標へ近づくと考える理由（任意）"><TextArea {...fieldProps(invalid, "field-hypothesis")} maxLength={2000} rows={3} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} /></Field>
      {mode === "create" && <Field label="判断理由" required description="なぜこのOutcomeを今選んだか。判断の記録として作成後は変更できません。"><TextArea {...fieldProps(invalid, "field-rationale")} required maxLength={2000} rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} /></Field>}</section>
    {mode === "create" ? <section className="form-section"><h2>成功条件</h2><p className="fixed-note">成功条件は作成時に固定され、後から編集できません。変更する場合は、このOutcomeを取り消して新しいOutcomeを作成します。1〜{maxSuccessCriteria}件。</p>
      <fieldset {...fieldProps(invalid, "field-successCriteria")}><legend className="visually-hidden">成功条件の一覧</legend>{criteria.map((criterion, index) => <fieldset className="criterion-row" key={index}><legend>成功条件 {index + 1}</legend>
        <Field label="内容" required description="何を満たせば成功か（例: duplicate_claim_count = 0）"><TextInput {...fieldProps(invalid, fieldId(`successCriteria.${index}.description`))} required maxLength={500} value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} /></Field>
        <Field label="測定方法" required description="どう観測し、どの証拠があれば成立と言えるか。「できた」という主張だけでは成立にできません。"><TextArea {...fieldProps(invalid, fieldId(`successCriteria.${index}.measurement`))} required maxLength={1000} rows={3} value={criterion.measurement} onChange={(event) => updateCriterion(index, { measurement: event.target.value })} /></Field>
        <Field label="目標値" description="任意（例: = 0、100%）"><TextInput {...fieldProps(invalid, fieldId(`successCriteria.${index}.target`))} maxLength={200} value={criterion.target} onChange={(event) => updateCriterion(index, { target: event.target.value })} /></Field>
        <Button variant="text" disabled={criteria.length <= 1} aria-label={`成功条件 ${index + 1}を削除`} onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}>この成功条件を削除</Button></fieldset>)}
        <Button variant="text" disabled={criteria.length >= maxSuccessCriteria} onClick={() => setCriteria([...criteria, emptyCriterion])}>＋ 成功条件を追加</Button></fieldset></section> : <p className="fixed-note">目指す変化・判断理由・成功条件は作成時に固定されています。編集できるのはOutcome名・貢献仮説・課題です。</p>}
    <section className="form-section" aria-labelledby="outcome-problems-heading"><h2 id="outcome-problems-heading">解決したい課題</h2><p className="fixed-note">課題ごとに根拠と解決策の仮説を記録します（任意、{maxOutcomeProblems}件まで）。Taskの停止などの開発上の障害はここに含めません。</p>
      <ProblemFields problems={problems} onChange={setProblems} invalid={invalid} options={evidenceOptions} /></section>
    <div className="form-actions"><LinkButton to={cancelTo} variant="secondary">キャンセル</LinkButton><Button type="submit" pending={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</Button></div></form></main>;
};
