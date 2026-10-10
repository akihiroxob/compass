import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../features/auth";
import { useWorkspaceNavigation } from "../features/workspace/WorkspaceContext";
import { WorkspaceNav, WorkspaceSwitcher } from "../features/workspace/WorkspaceSwitcher";

/** ログイン中だけ、Humanの表示名とlogoutを出す。logoutの失敗はその場に表示する。 */
const SessionMenu = () => {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!session) return <p>Direction workspace</p>;
  const logout = async () => {
    setError(null);
    setPending(true);
    try {
      await session.logout();
    } catch {
      setError("ログアウトできませんでした。通信状況を確認して再試行してください。");
      setPending(false);
    }
  };
  return (
    <div className="session-menu">
      <span title={session.human.email}>{session.human.displayName}</span>
      <button type="button" className="secondary-button compact" disabled={pending} onClick={() => void logout()}>
        {pending ? "ログアウト中..." : "ログアウト"}
      </button>
      {error && <span role="alert" className="session-menu-error">{error}</span>}
    </div>
  );
};

/**
 * 画面の枠。Workspaceのナビゲーションの中（ログイン後）では、Desktopは左のsidebarにWorkspace Selector・ナビゲーション・Sessionを、
 * 狭い画面は上端にSelector・Session、下端にナビゲーションを置く。外（ログイン・Session復元中）はheaderだけを出す。
 */
export const Shell = ({ children }: { children: ReactNode }) => {
  const navigation = useWorkspaceNavigation();
  const brand = <Link to="/" className="brand"><span aria-hidden="true">◒</span> Compass</Link>;
  if (!navigation) {
    return (
      <>
        <header className="site-header">{brand}<SessionMenu /></header>
        {children}
      </>
    );
  }
  return (
    <div className="app-shell">
      <a href="#app-content" className="skip-link">本文へ移動</a>
      <header className="app-sidebar">
        {brand}
        <WorkspaceSwitcher />
        <WorkspaceNav />
        <div className="app-sidebar-footer">
          <Link to="/projects" className="sidebar-link">参加中のProject</Link>
          <SessionMenu />
        </div>
      </header>
      <div className="app-content" id="app-content" tabIndex={-1}>{children}</div>
    </div>
  );
};
