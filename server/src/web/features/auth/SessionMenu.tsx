import { useState } from "react";
import { useSession } from "./SessionContext";

/** ログイン中だけ、Humanの表示名とlogoutを出す。logoutの失敗はその場に表示する。 */
export const SessionMenu = () => {
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
