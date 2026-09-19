import { useState, type FormEvent, type ReactNode } from "react";
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
  /** 理由欄のラベル。必須なら`<span>必須</span>`を含める。 */
  label: ReactNode;
  required?: boolean;
  confirmLabel: string;
  pendingLabel: string;
};

export const ReasonPanel = ({ action, title, description, label, required = false, confirmLabel, pendingLabel }: ReasonPanelProps) => (
  <form className="abandon-panel" onSubmit={action.submit}>
    <h2>{title}</h2>
    <p>{description}</p>
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
    {action.error && (
      <div className="state-card error" role="alert">
        {action.error}
      </div>
    )}
    <div className="form-actions">
      <button type="button" className="secondary-button" onClick={action.cancel}>
        やめる
      </button>
      <button className="button danger" disabled={action.isPending}>
        {action.isPending ? pendingLabel : confirmLabel}
      </button>
    </div>
  </form>
);
