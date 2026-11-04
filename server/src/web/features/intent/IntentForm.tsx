import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Button, Field, LinkButton, TextArea, TextInput } from "../../components/ui";
import { intentFieldLabels, type Intent, type IntentFormField, type IntentFormValues } from "./intent";

type IntentFormProps = {
  initial: IntentFormValues;
  heading: { eyebrow: string; title: string; lede: string };
  submitLabel: string;
  pendingLabel: string;
  cancelTo: string;
  save: (values: IntentFormValues) => Promise<Intent>;
  /** 保存後に開く画面。 */
  savedTo: (intent: Intent) => string;
  /** 既にActiveなIntentがあるときに開く画面。 */
  activeIntentTo: (intentId: string) => string;
  /** archivedで拒否されたときに内容を確認できる画面。 */
  detailTo: string;
};

/** 入力エラーの項目名を、このフォームの表示名（目標名・達成条件等）にそろえる。 */
const withIntentLabels = (error: FormError): FormError =>
  error.kind === "validation"
    ? { ...error, issues: error.issues.map((issue) => {
      const field = issue.fieldId?.replace(/^field-/, "") as IntentFormField | undefined;
      return field && field in intentFieldLabels ? { ...issue, label: intentFieldLabels[field] } : issue;
    }) }
    : error;

/**
 * Intent（ビジネス目標）の作成・編集フォーム。目標名・実現したい状態が必須、ほかは任意（契約はserverの`intentSchema`、MCPと共通）。
 * 保存はIntentの登録・更新だけで、Agentの起動・相談は行わない。
 */
export const IntentForm = ({ initial, heading, submitLabel, pendingLabel, cancelTo, save, savedTo, activeIntentTo, detailTo }: IntentFormProps) => {
  const navigate = useNavigate();
  const [values, setValues] = useState<IntentFormValues>(initial);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const bind = (field: IntentFormField) => ({
    ...fieldProps(invalid, `field-${field}`),
    value: values[field],
    onChange: (event: { target: { value: string } }) => setValues((current) => ({ ...current, [field]: event.target.value })),
  });
  const text = (field: IntentFormField, options: { required?: boolean; rows?: number; placeholder: string; description?: ReactNode }) => (
    <Field label={intentFieldLabels[field]} required={options.required} description={options.description}>
      <TextArea {...bind(field)} required={options.required} maxLength={2000} rows={options.rows ?? 4} placeholder={options.placeholder} />
    </Field>
  );
  // 保存に失敗しても入力stateは維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      navigate(savedTo(await save(values)));
    } catch (reason) {
      const classified = classifyError(reason);
      setError(classified.kind === "not_found" ? { kind: "other", message: "WorkspaceまたはIntentが見つかりません。削除されたか、閲覧する権限がありません。" } : withIntentLabels(classified));
    } finally {
      setIsSubmitting(false);
    }
  };
  const activeIntentId = error?.kind === "conflict" ? error.activeIntentId : null;
  return (
    <main className="narrow">
      <Link to={cancelTo} className="back-link">← 戻る</Link>
      <div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div>
      <p className="lede">{heading.lede}</p>
      {error && <FormErrorSummary error={error} detailTo={detailTo} archivedScope="Workspace" conflict={{ title: "この操作は現在のIntentの状態と競合しています。", action: activeIntentId && <Link to={activeIntentTo(activeIntentId)} className="text-link">Active Intentを開く →</Link> }} />}
      <form onSubmit={submit} className="project-form">
        <section className="form-section">
          <Field label={intentFieldLabels.title} required description="100文字まで">
            <TextInput {...bind("title")} required maxLength={100} placeholder="例：売上を月30万円へ" />
          </Field>
          {text("desiredState", { required: true, rows: 5, placeholder: "例：継続的な運営を支えるため、月間売上30万円を実現する。", description: "実装手段ではなく、実現後の状態を書きます。" })}
        </section>
        <section className="form-section" aria-labelledby="intent-context-heading">
          <h2 id="intent-context-heading">背景・対象・制約</h2>
          <div className="intent-context-fields">
            {text("background", { placeholder: "例：学習体験を継続して提供できる売上基盤をつくりたい。" })}
            {text("audience", { placeholder: "例：無料体験から有料利用を検討する人。" })}
            {text("constraints", { placeholder: "例：短期的な売上のために、学習体験や継続率を損なわない。" })}
          </div>
        </section>
        <section className="form-section" aria-labelledby="intent-completion-heading">
          <h2 id="intent-completion-heading">達成の確認</h2>
          {text("completionDefinition", { placeholder: "例：対象月の売上が30万円以上になったことを、売上データで確認できる。", description: "何が示されればこの目標全体を達成と言えるか" })}
          <Field label={intentFieldLabels.targetDate}>
            <TextInput {...bind("targetDate")} type="date" />
          </Field>
        </section>
        <div className="form-actions">
          <LinkButton to={cancelTo} variant="secondary">キャンセル</LinkButton>
          <Button type="submit" pending={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</Button>
        </div>
      </form>
    </main>
  );
};
