import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";
import { Shell } from "../components/Shell";
import { AuthGate, SessionMenu } from "../features/auth";
import { WorkspaceNav, WorkspaceNavigationProvider, WorkspaceSwitcher } from "../features/workspace";

/** Session無しで開く画面（ログイン・招待）とSession復元中の枠。headerにはSessionの表示だけを出す。 */
const PublicFrame = ({ children }: { children: ReactNode }) => <Shell session={<SessionMenu />}>{children}</Shell>;

/** Session無しで開ける画面のroute layout。 */
export const PublicLayout = () => <PublicFrame><Outlet /></PublicFrame>;

/**
 * ログイン後の画面のroute layout。AuthGateがSessionを復元してから、Workspaceのナビゲーションを提供し、
 * Shellへ現在のWorkspaceのSelector・ナビゲーション・参加中のProject・Sessionを合成する。各Featureの画面は`Outlet`へ描画する。
 */
export const AuthenticatedLayout = () => (
  <AuthGate layout={PublicFrame}>
    <WorkspaceNavigationProvider>
      <Shell
        navigation={<><WorkspaceSwitcher /><WorkspaceNav /></>}
        footer={<Link to="/projects" className="sidebar-link">参加中のProject</Link>}
        session={<SessionMenu />}
      >
        <Outlet />
      </Shell>
    </WorkspaceNavigationProvider>
  </AuthGate>
);
