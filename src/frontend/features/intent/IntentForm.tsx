import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Shell } from "../../components/Shell";
import type { Intent, IntentFormValues } from "../../intentForm";
import { intentPath } from "../../paths";

type IntentFormProps = { projectId: string; initial: IntentFormValues; heading: { eyebrow: string; title: string; lede: string }; submitLabel: string; pendingLabel: string; cancelTo: string; save: (values: IntentFormValues) => Promise<Intent> };

export const IntentForm = ({ projectId, initial, heading, submitLabel, pendingLabel, cancelTo, save }: IntentFormProps) => {
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial.title);
  const [desiredState, setDesiredState] = useState(initial.desiredState);
  const [completionDefinition, setCompletionDefinition] = useState(initial.completionDefinition);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const intent = await save({ title, desiredState, completionDefinition }); navigate(intentPath(projectId, intent.id)); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "not_found" ? { kind: "other", message: "ProjectまたはIntentが見つかりません。削除された可能性があります。" } : classified); } finally { setIsSubmitting(false); } };
  const activeIntentId = error?.kind === "conflict" ? error.activeIntentId : null;
  return <Shell><main className="narrow"><Link to={cancelTo} className="back-link">← 戻る</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>
    {error && <FormErrorSummary error={error} conflict={{ title: "この操作は現在のIntentの状態と競合しています。", action: activeIntentId && <Link to={intentPath(projectId, activeIntentId)} className="text-link">Active Intentを開く →</Link> }} />}
    <form onSubmit={submit} className="project-form"><section className="form-section"><label>タイトル <span>必須</span><small>Intentを一言で表す名前（100文字まで）</small><input {...fieldProps(invalid, "field-title")} required aria-required="true" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>実現したい状態 <span>必須</span><small>Humanが今実現したい状態。実装手段ではなく、実現後の状態を書きます。</small><textarea {...fieldProps(invalid, "field-desiredState")} required aria-required="true" maxLength={2000} rows={6} value={desiredState} onChange={(event) => setDesiredState(event.target.value)} /></label><label>完了の定義<small>何が示されればこのIntent全体が完了と言えるか（任意）</small><textarea {...fieldProps(invalid, "field-completionDefinition")} maxLength={2000} rows={4} value={completionDefinition} onChange={(event) => setCompletionDefinition(event.target.value)} /></label></section>
    <div className="form-actions"><Link to={cancelTo} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};
