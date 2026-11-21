import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Shell } from "../components/Shell";
import { workspaceCreatePath } from "../paths";
import { AuthGate, SessionAvatar, SessionMenu } from "../features/auth";
import { WorkspaceNav, WorkspaceNavigationProvider, WorkspaceProjectNav, WorkspaceSwitcher } from "../features/workspace";

/** Session無しで開く画面（ログイン・招待）とSession復元中の枠。headerにはSessionの表示だけを出す。 */
const PublicFrame = ({ children }: { children: ReactNode }) => <Shell session={<SessionMenu />}>{children}</Shell>;

/** Session無しで開ける画面のroute layout。 */
export const PublicLayout = () => <PublicFrame><Outlet /></PublicFrame>;

/**
 * ログイン後の画面のroute layout。AuthGateがSessionを復元してから、Workspaceのナビゲーションを提供し、
 * Shellへ現在のWorkspaceのSelector・メニュー・ProjectとそのView・Workspaceを横断する入口・Sessionを合成する。各Featureの画面は`Outlet`へ描画する。
 */
export const AuthenticatedLayout = () => {
  const { pathname } = useLocation();
  const showWorkspaceMenu = pathname !== "/" && pathname.replace(/\/$/, "") !== workspaceCreatePath;
  return (
    <AuthGate layout={PublicFrame}>
      <WorkspaceNavigationProvider>
        <Shell
          switcher={<WorkspaceSwitcher />}
          navigation={showWorkspaceMenu ? <><WorkspaceNav /><WorkspaceProjectNav /></> : undefined}
          session={<SessionMenu />}
          account={<SessionAvatar />}
        >
          <Outlet />
        </Shell>
      </WorkspaceNavigationProvider>
    </AuthGate>
  );
};
