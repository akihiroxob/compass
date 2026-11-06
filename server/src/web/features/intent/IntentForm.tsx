import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { classifyError } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Button, Field, LinkButton, TextArea, TextInput } from "../../components/ui";
import { formValuesFromIntent, intentFieldLabels, type Intent, type IntentFormField, type IntentFormValues } from "./intent";

type IntentFormProps = {
  initial: IntentFormValues;
  heading: { eyebrow: string; title: string; lede: string };
  submitLabel: string;
  pendingLabel: string;
  cancelTo: string;
  save: (values: IntentFormValues, context: { expectedVersion: number | null; reason: string }) => Promise<Intent>;
  /** 編集のとき。画面を開いた時点の版と、最新の目標を読み直す関数。作成では渡さない。 */
  edit?: { version: number; reload: () => Promise<Intent> };
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
      return field && field in intentFieldLabels ? { ...issue, label: intentFieldLabels[field as IntentFormField | "reason"] } : issue;
    }) }
    : error;

/**
 * Intent（ビジネス目標）の作成・編集フォーム。目標名・実現したい状態が必須、ほかは任意（契約はserverの`intentSchema`、MCPと共通）。
 * 保存はIntentの登録・更新だけで、Agentの起動・相談は行わない。
 */
export const IntentForm = ({ initial, heading, submitLabel, pendingLabel, cancelTo, save, edit, savedTo, activeIntentTo, detailTo }: IntentFormProps) => {
  const navigate = useNavigate();
  const [values, setValues] = useState<IntentFormValues>(initial);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 編集の元にした版。競合後に最新を読み込んだときだけ進める（保存で自動的に現在版へ合わせない）。
  const [version, setVersion] = useState(edit?.version ?? null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
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
      navigate(savedTo(await save(values, { expectedVersion: version, reason })));
    } catch (reason) {
      const classified = classifyError(reason);
      setError(classified.kind === "not_found" ? { kind: "other", message: "WorkspaceまたはIntentが見つかりません。削除されたか、閲覧する権限がありません。" } : withIntentLabels(classified));
    } finally {
      setIsSubmitting(false);
    }
  };
  const activeIntentId = error?.kind === "conflict" ? error.activeIntentId : null;
  const versionConflict = error?.kind === "conflict" && error.conflict === "intent_version" && edit !== undefined;
  // 競合時は、入力を黙って上書きせず、利用者が最新を読み込むと決めたときだけ入力を置き換える。
  const reloadLatest = async () => {
    if (!edit) return;
    setIsReloading(true);
    try {
      const latest = await edit.reload();
      setValues(formValuesFromIntent(latest));
      setVersion(latest.version);
      setReason("");
      setError(null);
      setNotice(`最新の内容（v${latest.version}）を読み込みました。内容を確認して保存してください。`);
    } catch (failure) {
      const classified = classifyError(failure);
      setError(classified.kind === "not_found" ? { kind: "other", message: "目標が見つかりません。削除されたか、閲覧する権限がありません。" } : withIntentLabels(classified));
    } finally {
      setIsReloading(false);
    }
  };
  return (
    <main className="narrow">
      <Link to={cancelTo} className="back-link">← 戻る</Link>
      <div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div>
      <p className="lede">{heading.lede}</p>
      {error && <FormErrorSummary error={error} detailTo={detailTo} archivedScope="Workspace" conflict={{ title: versionConflict ? "目標が更新されています。" : "この操作は現在のIntentの状態と競合しています。", action: versionConflict ? <Button type="button" variant="secondary" pending={isReloading} onClick={reloadLatest}>{isReloading ? "読み込み中..." : "最新の内容を読み込む（入力は置き換わります）"}</Button> : activeIntentId && <Link to={activeIntentTo(activeIntentId)} className="text-link">Active Intentを開く →</Link> }} />}
      {notice && !error && <p role="status" className="section-note">{notice}</p>}
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
        {edit && (
          <section className="form-section" aria-labelledby="intent-reason-heading">
            <h2 id="intent-reason-heading">変更の記録</h2>
            <Field label={intentFieldLabels.reason} description="既にOutcomeがある目標の実現したい状態・達成条件を変えるときは必須です。履歴に変更者とともに残り、既存のOutcome・評価は元の版を参照し続けます。">
              <TextArea {...fieldProps(invalid, "field-reason")} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} rows={3} placeholder="例：調査の結果、対象を既存会員に絞る方針へ変えた。" />
            </Field>
          </section>
        )}
        <div className="form-actions">
          <LinkButton to={cancelTo} variant="secondary">キャンセル</LinkButton>
          <Button type="submit" pending={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</Button>
        </div>
      </form>
    </main>
  );
};
