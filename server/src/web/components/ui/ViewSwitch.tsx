import type { ReactNode } from "react";
import { Link, type To } from "react-router-dom";
import { controlSizeClass, type ControlSize } from "./LinkButton";

export type ViewSwitchItem = { key: string; to: To; label: ReactNode; current: boolean; count?: number };

/**
 * URLで表す表示の切替（一覧のstatus・絞り込み等）。各項目は通常のリンクで、選択中の項目に`aria-current="page"`を付ける。
 * 外側余白は持たないため、一覧との間隔は利用側のlayout（`.list-toolbar`等）が持つ。
 */
export const ViewSwitch = ({ label, items, size = "md" }: { label: string; items: ViewSwitchItem[]; size?: ControlSize }) => (
  <nav className="view-switch" aria-label={label}>
    {items.map((item) => (
      <Link key={item.key} to={item.to} className={`view-switch-item${controlSizeClass(size)}`} aria-current={item.current ? "page" : undefined}>
        {item.label}
        {item.count !== undefined && <span className="view-switch-count">{item.count}</span>}
      </Link>
    ))}
  </nav>
);
