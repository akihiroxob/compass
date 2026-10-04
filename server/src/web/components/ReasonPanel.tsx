import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { classifyError, type ErrorKind } from "../api";

/** 理由を添えて取り返しのつかない操作（放棄・取消）を確認するパネルの状態。 */
export const useReasonAction = (run: (reason: string) => Promise<void>, describeFailure: (classified: ErrorKind) => string) => {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsPending(true);
    try {
      await run(reason);
      setConfirming(false);
    } catch (failure) {
      setError(describeFailure(classifyError(failure)));
    } finally {
      setIsPending(false);
    }
  };
  const cancel = () => {
    setConfirming(false);
    setError(null);
  };
  return { confirming, open: () => setConfirming(true), reason, setReason, isPending, error, submit, cancel };
};

export type ReasonAction = ReturnType<typeof useReasonAction>;

type ReasonPanelProps = {
  action: ReasonAction;
  title: string;
  description: string;
  /** 理由欄のラベル。必須なら`<span>必須</span>`を含める。省略すると理由欄を出さず、確認だけを求める。 */
  label?: ReactNode;
  required?: boolean;
  confirmLabel: string;
  pendingLabel: string;
  /** 取り返しのつかない操作でなければ`false`（確定ボタンを通常の色にする）。 */
  danger?: boolean;
};

export const ReasonPanel = ({ action, title, description, label, required = false, confirmLabel, pendingLabel, danger = true }: ReasonPanelProps) => {
  // 理由欄が無い確認だけのパネルは、見出しへfocusを移してkeyboard・読み上げで確認内容を先に伝える（確定ボタンには移さない）。
  const heading = useRef<HTMLHeadingElement>(null);
  const hasReason = label !== undefined;
  useEffect(() => {
    if (!hasReason) heading.current?.focus();
  }, [hasReason]);
  return (
  <form className="abandon-panel" onSubmit={action.submit}>
    <h2 ref={heading} tabIndex={-1}>{title}</h2>
    <p>{description}</p>
    {label !== undefined && (
      <label>
        {label}
        <textarea
          autoFocus
          {...(required ? { required: true, "aria-required": true } : {})}
          maxLength={2000}
          rows={3}
          value={action.reason}
          onChange={(event) => action.setReason(event.target.value)}
        />
      </label>
    )}
    {action.error && (
      <div className="state-card error" role="alert">
        {action.error}
      </div>
    )}
    <div className="form-actions">
      <button type="button" className="secondary-button" onClick={action.cancel}>
        やめる
      </button>
      <button className={danger ? "button danger" : "button"} disabled={action.isPending}>
        {action.isPending ? pendingLabel : confirmLabel}
      </button>
    </div>
  </form>
  );
};
