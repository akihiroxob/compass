import type { ComponentPropsWithRef } from "react";

// 線で描くアイコン（24pxの格子）。色は`currentColor`で、ボタンの文字色に従う。
const paths = {
  close: "M6 6l12 12M18 6L6 18",
  menu: "M4 6h16M4 12h16M4 18h16",
} as const;

export type IconButtonProps = Omit<ComponentPropsWithRef<"button">, "className" | "style" | "children" | "aria-label"> & {
  icon: keyof typeof paths;
  /** 読み上げ名（`aria-label`）。見える文字を持たないため必須。 */
  label: string;
};

/**
 * アイコンだけのボタン（閉じる×・メニュー）。操作領域は44px四方で、読み上げ名を`label`で必ず持つ。
 * `type`の既定は`button`。外側余白・配置は親layoutが持つため、`className`・`style`は受け取らない。
 */
export const IconButton = ({ icon, label, type = "button", ...props }: IconButtonProps) => (
  <button {...props} type={type} aria-label={label} className="icon-button">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={paths[icon]} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  </button>
);
