import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { classifyError, type ErrorKind } from "../api";
import { StateCard } from "./StateCard";
import { Button, Field, TextArea } from "./ui";

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
  /** 理由欄のラベル。必須の表示は`required`で付く。省略すると理由欄を出さず、確認だけを求める。 */
  label?: ReactNode;
  required?: boolean;
  confirmLabel: string;
  pendingLabel: string;
  /** 取り返しのつかない操作でなければ`false`（確定ボタンを通常の色にする）。 */
  danger?: boolean;
};

type ConfirmPanelProps = {
  title: string;
  description: string;
  /** 確認に必要な入力（理由・期間等）。 */
  children?: ReactNode;
  error: string | null;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  /** 確定ボタンの文言。送信中の文言への切替は利用側が行う。 */
  submitLabel: string;
  pending: boolean;
  /** 取り返しのつかない操作なら`true`（確定ボタンを危険操作の色にする）。 */
  danger?: boolean;
  /** 入力の無い確認だけのパネルは`true`。見出しへfocusを移し、keyboard・読み上げで確認内容を先に伝える（確定ボタンには移さない）。 */
  focusHeading?: boolean;
};

/** 操作を確定する前の確認パネル。見出し・説明・入力・失敗・やめる/確定の配置と見た目を持ち、操作の実行はFeatureが持つ。 */
export const ConfirmPanel = ({ title, description, children, error, onSubmit, onCancel, submitLabel, pending, danger = false, focusHeading = false }: ConfirmPanelProps) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  return (
    <form className="abandon-panel" onSubmit={onSubmit}>
      <h2 ref={heading} tabIndex={-1}>{title}</h2>
      <p>{description}</p>
      {children}
      {error && (
        <StateCard tone="error" role="alert">
          {error}
        </StateCard>
      )}
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          やめる
        </Button>
        <Button type="submit" tone={danger ? "danger" : undefined} pending={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};

/** 理由を添えて（または確認だけで）取り返しのつかない操作を確定するパネル。`useReasonAction`の状態を使う。 */
export const ReasonPanel = ({ action, title, description, label, required = false, confirmLabel, pendingLabel, danger = true }: ReasonPanelProps) => (
  <ConfirmPanel
    title={title}
    description={description}
    error={action.error}
    onSubmit={action.submit}
    onCancel={action.cancel}
    submitLabel={action.isPending ? pendingLabel : confirmLabel}
    pending={action.isPending}
    danger={danger}
    focusHeading={label === undefined}
  >
    {label !== undefined && (
      <Field label={label} required={required}>
        <TextArea
          autoFocus
          required={required}
          maxLength={2000}
          rows={3}
          value={action.reason}
          onChange={(event) => action.setReason(event.target.value)}
        />
      </Field>
    )}
  </ConfirmPanel>
);
