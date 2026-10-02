import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ErrorKind } from "../api";

/** フォーム送信の失敗。not_foundは各フォームが文言付きの`other`へ変換してから保持する。 */
export type FormError = Exclude<ErrorKind, { kind: "not_found" }>;

type FieldProps = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };
const summaryId = "form-error-summary";

/** 入力欄のprops。issueの対象になっている欄だけ`aria-invalid`と要約への関連付けを付ける。 */
export const fieldProps = (invalid: ReadonlySet<string>, id: string): FieldProps =>
  invalid.has(id) ? { id, "aria-invalid": true, "aria-describedby": summaryId } : { id };

export const invalidFieldIds = (error: FormError | null): ReadonlySet<string> =>
  new Set(error?.kind === "validation" ? error.issues.flatMap((issue) => (issue.fieldId ? [issue.fieldId] : [])) : []);

type FormErrorSummaryProps = {
  error: FormError;
  /** 409 conflictの表示。省略した場合、conflictも保存失敗として表示する。 */
  conflict?: { title: string; action?: ReactNode };
  /** Projectがarchivedで拒否された場合に、内容を確認できるProject詳細への導線。 */
  projectDetailTo?: string;
};

/** マウント時と`error`が変わるたびにフォーカスを移す。`error`があるときだけ描画すること。 */
export const FormErrorSummary = ({ error, conflict, projectDetailTo }: FormErrorSummaryProps) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: "center" });
  }, [error]);
  return (
    <div className="state-card error" role="alert" id={summaryId} tabIndex={-1} ref={ref}>
      {error.kind === "validation" ? (
        <>
          <p className="error-title">入力内容を確認してください</p>
          <ul>
            {error.issues.map((issue, index) => (
              <li key={index}>
                {issue.fieldId ? <a href={`#${issue.fieldId}`}>{issue.label}</a> : issue.label}: {issue.message}
              </li>
            ))}
          </ul>
        </>
      ) : error.kind === "project_archived" ? (
        <>
          <p className="error-title">{error.message}</p>
          <p>このProjectはアーカイブされています。入力した内容は保存されていません。</p>
          {projectDetailTo && <Link to={projectDetailTo} className="text-link">Project詳細を開く →</Link>}
        </>
      ) : error.kind === "conflict" && conflict ? (
        <>
          <p className="error-title">{conflict.title}</p>
          <p>{error.message}</p>
          {conflict.action}
        </>
      ) : (
        <>
          <p className="error-title">保存に失敗しました。時間をおいて再試行してください。</p>
          <p>{error.message}</p>
        </>
      )}
    </div>
  );
};
