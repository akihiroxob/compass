import type { ComponentPropsWithRef } from "react";
import { controlSizeClass, type ControlSize } from "./LinkButton";

const variantClasses = { primary: "button", secondary: "secondary-button", text: "text-button" } as const;

export type ButtonProps = Omit<ComponentPropsWithRef<"button">, "className" | "style"> & {
  /** `text`は枠の無い文字だけのボタン（入力行の追加・削除等）。sizeを持たない。 */
  variant?: keyof typeof variantClasses;
  size?: ControlSize;
  /** 取り返しのつかない操作（取消・削除等）。 */
  tone?: "danger";
  /** 送信中。押せなくし、`aria-busy`で処理中を伝える（二重送信の防止）。文言の切替は利用側が行う。 */
  pending?: boolean;
};

/**
 * 操作のボタン。`type`の既定は`button`で、フォームの送信は`type="submit"`を明示する。遷移はLinkButtonを使う。
 * 外側余白・幅・配置は親layoutが持つため、`className`・`style`は受け取らない。
 */
export const Button = ({ variant = "primary", size = "md", tone, pending = false, type = "button", disabled, ...props }: ButtonProps) => (
  <button
    {...props}
    type={type}
    disabled={disabled || pending}
    aria-busy={pending || undefined}
    className={`${variantClasses[variant]}${variant === "text" ? "" : controlSizeClass(size)}${tone ? ` ${tone}` : ""}`}
  />
);
