import type { ReactNode } from "react";

export type FieldProps = {
  label: ReactNode;
  /** 必須の表示（「必須」）。入力の検証は入力部品の`required`が行うため、両方に指定する。 */
  required?: boolean;
  /** 入力の説明（文字数・書き方等）。labelに含めて読み上げる。 */
  description?: ReactNode;
  /** labelを見た目から隠し、読み上げにだけ残す（一覧の行内の選択等）。 */
  labelHidden?: boolean;
  /** `inline`はlabelと入力を横に並べる（絞り込み・行内の選択）。 */
  layout?: "stack" | "inline";
  /** 入力部品を1つ置く。入力のid・aria-invalid（`fieldProps`）は入力部品へ渡す。 */
  children: ReactNode;
};

/**
 * 入力1つとlabel・必須表示・説明の組。`<label>`で入力を包み、labelと入力を関連付ける。
 * 入力欄の上下の間隔は親layout（`.form-section`等のgap）が持つため、外側余白を持たない。
 */
export const Field = ({ label, required = false, description, labelHidden = false, layout = "stack", children }: FieldProps) => (
  <label className={`field${layout === "inline" ? " inline" : ""}`}>
    {labelHidden ? (
      <span className="visually-hidden">{label}</span>
    ) : (
      <span className="field-label">
        {label}
        {required && <> <span className="field-required">必須</span></>}
      </span>
    )}
    {description !== undefined && <small className="field-description">{description}</small>}
    {children}
  </label>
);
