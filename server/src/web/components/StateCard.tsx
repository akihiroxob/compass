import type { ComponentPropsWithRef } from "react";

export type StateCardProps = Omit<ComponentPropsWithRef<"div">, "className" | "style"> & {
  /** 失敗・拒否の表示。読み上げの`role`（`alert`・`status`）は利用側が内容に合わせて指定する。 */
  tone?: "error";
};

/** 読込・失敗・空・案内の枠。外側の余白は持つが、幅・配置は親layoutに任せ、`className`・`style`は受け取らない。 */
export const StateCard = ({ tone, ...props }: StateCardProps) => <div {...props} className={tone ? `state-card ${tone}` : "state-card"} />;

export const Loading = () => <StateCard role="status">読み込み中...</StateCard>;

export const ErrorState = ({ message }: { message: string }) => <StateCard tone="error" role="alert">{message}</StateCard>;
