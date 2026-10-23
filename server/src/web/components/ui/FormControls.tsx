import type { ComponentPropsWithRef, ReactNode } from "react";
import { controlSizeClass, type ControlSize } from "./LinkButton";

// 入力の基本部品。標準のHTML属性とrefをそのまま渡し、`required`には`aria-required`を添える。
// 見た目（size・枠・focus・disabled・aria-invalid）は部品のclassとトークンが持つため、`className`・`style`は受け取らない。
// labelとの関連付けはFieldで包むか、`aria-label`で行う。

type Native<T extends "input" | "textarea" | "select"> = Omit<ComponentPropsWithRef<T>, "className" | "style">;

export type TextInputProps = Omit<Native<"input">, "type" | "size"> & {
  type?: "text" | "email" | "url" | "search" | "password" | "number" | "tel";
  size?: ControlSize;
};

/** 1行の文字入力。 */
export const TextInput = ({ type = "text", size = "md", required, ...props }: TextInputProps) => (
  <input aria-required={required || undefined} {...props} type={type} required={required} className={`input${controlSizeClass(size)}`} />
);

export type TextAreaProps = Native<"textarea">;

/** 複数行の文字入力。高さは`rows`で指定する。 */
export const TextArea = ({ required, ...props }: TextAreaProps) => (
  <textarea aria-required={required || undefined} {...props} required={required} className="textarea" />
);

export type SelectProps = Omit<Native<"select">, "size" | "multiple"> & { size?: ControlSize };

/** 1つを選ぶ選択。選択肢は`<option>`・`<optgroup>`を子に渡す。 */
export const Select = ({ size = "md", required, ...props }: SelectProps) => (
  <select aria-required={required || undefined} {...props} required={required} className={`select${controlSizeClass(size)}`} />
);

export type CheckboxProps = Omit<Native<"input">, "type" | "size" | "children"> & { children: ReactNode };

/** 選択肢1つのcheckbox。`children`がlabelになる。 */
export const Checkbox = ({ children, ...props }: CheckboxProps) => (
  <label className="checkbox">
    <input {...props} type="checkbox" />
    <span>{children}</span>
  </label>
);
