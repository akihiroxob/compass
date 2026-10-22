import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * 画面の枠。表示だけを持ち、各slotの中身（Workspaceのナビゲーション・Session等）はappが合成して渡す。
 * `navigation`を渡すと、Desktopは左のsidebarにナビゲーション・`footer`・`session`を、狭い画面は上端にナビゲーションの先頭・`session`、
 * 下端にナビゲーションを置く。渡さない（ログイン・Session復元中）とheaderに`session`だけを出す。
 */
export const Shell = ({ navigation, footer, session, children }: { navigation?: ReactNode; footer?: ReactNode; session: ReactNode; children: ReactNode }) => {
  const brand = <Link to="/" className="brand"><span aria-hidden="true">◒</span> Compass</Link>;
  if (navigation === undefined) {
    return (
      <>
        <header className="site-header">{brand}{session}</header>
        {children}
      </>
    );
  }
  return (
    <div className="app-shell">
      <a href="#app-content" className="skip-link">本文へ移動</a>
      <header className="app-sidebar">
        {brand}
        {navigation}
        <div className="app-sidebar-footer">
          {footer}
          {session}
        </div>
      </header>
      <div className="app-content" id="app-content" tabIndex={-1}>{children}</div>
    </div>
  );
};
