import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Dialog, IconButton } from "./ui";

/** 狭い画面の判定。`styles/_tokens.scss`の`$breakpoint-narrow`と同じ値。 */
const narrowQuery = "(max-width: 700px)";

const useNarrow = () => {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
};

type ShellProps = {
  /** メニューの先頭に置く切替（Workspace選択）。狭い画面では閉じる×と同じ行に置く。 */
  switcher?: ReactNode;
  navigation?: ReactNode;
  footer?: ReactNode;
  session: ReactNode;
  /** 狭い画面のheaderに`session`の代わりに置く名前アイコン。指定すると`session`は狭い画面のメニューの下端に置く。 */
  account?: ReactNode;
  children: ReactNode;
};

/**
 * 画面の枠。表示だけを持ち、各slotの中身（Workspaceの切替・ナビゲーション・Session等）はappが合成して渡す。
 * 上端のheaderにブランドと`session`を置く。`navigation`を渡すと、Desktopは左のメニューに`switcher`・`navigation`・`footer`を置き、
 * 狭い画面はheaderの名前アイコン（`account`）の右のメニューボタンから、同じ内容と`session`を右端のDialogで開く（ヘッダー下に別のナビゲーションを置かない）。
 * 画面を移ると狭い画面のメニューは閉じる。渡さない（ログイン・Session復元中）とheaderだけを出す。
 */
export const Shell = ({ switcher, navigation, footer, session, account, children }: ShellProps) => {
  const brand = <Link to="/" className="brand"><span aria-hidden="true">◒</span> Compass</Link>;
  const narrow = useNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const { pathname, search } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname, search, narrow]);
  if (navigation === undefined) {
    return (
      <>
        <header className="site-header">{brand}{session}</header>
        {children}
      </>
    );
  }
  const compact = narrow && account !== undefined;
  const menu = <>{navigation}<div className="app-menu-footer">{footer}{compact && session}</div></>;
  return (
    <>
      <a href="#app-content" className="skip-link">本文へ移動</a>
      <header className="site-header app-header">
        {brand}
        <div className="app-header-end">
          {compact ? account : session}
          {narrow && <IconButton icon="menu" label="メニュー" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen(true)} />}
        </div>
      </header>
      <div className="app-shell">
        {!narrow && <aside className="app-sidebar" aria-label="メニュー">{switcher}{menu}</aside>}
        <div className="app-content" id="app-content" tabIndex={-1}>{children}</div>
      </div>
      {narrow && <Dialog id={menuId} open={menuOpen} onClose={() => setMenuOpen(false)} title="メニュー" header={switcher} placement="end"><div className="app-menu">{menu}</div></Dialog>}
    </>
  );
};
