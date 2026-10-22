import { Link, type LinkProps } from "react-router-dom";

/** 操作部品のsize契約（`--control-{size}-*`）。同じ操作列の部品は同じsizeを指定する。 */
export type ControlSize = "md" | "sm";

/** sizeのclass。`md`は既定の見た目、`sm`は`compact`。 */
export const controlSizeClass = (size: ControlSize) => (size === "sm" ? " compact" : "");

export type LinkButtonProps = Omit<LinkProps, "className" | "style"> & {
  variant?: "primary" | "secondary";
  size?: ControlSize;
};

/**
 * ボタンの見た目の遷移リンク。通常の`<a href>`としてURL遷移・新しいタブ・戻る/再読込を保つ。
 * 外側余白・幅・配置は親layoutが持つため、`className`・`style`は受け取らない。
 */
export const LinkButton = ({ variant = "primary", size = "md", ...props }: LinkButtonProps) => (
  <Link {...props} className={`${variant === "primary" ? "button" : "secondary-button"}${controlSizeClass(size)}`} />
);
