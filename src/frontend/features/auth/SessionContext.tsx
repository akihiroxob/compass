import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError, onSessionLost, request, setCsrfToken } from "../../api";
import { Shell } from "../../components/Shell";
import { Loading } from "../../components/StateCard";
import { loginPath, logoutPath, sessionPath, type SessionHuman, type SessionInfo } from "./auth";

type SessionState = { human: SessionHuman; logout: () => Promise<void> };
const SessionContext = createContext<SessionState | null>(null);

/** ログイン中のHuman。AuthGateの外（ログイン画面・招待画面）では`null`。 */
export const useSession = () => useContext(SessionContext);

const fetchSession = () => request<SessionInfo>(sessionPath);

/**
 * 操作中のSession切れ。画面を差し替えず（入力を失わない）、別タブでの再ログインと、戻ってからの確認を促す。
 * 確認で有効なSessionが見つかれば、新しいCSRF tokenへ差し替えて閉じる。
 */
const SessionLostBanner = ({ onRestored }: { onRestored: (session: SessionInfo) => void }) => {
  const location = useLocation();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setMessage(null);
    try {
      onRestored(await fetchSession());
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 0 ? "サーバーに接続できませんでした。通信状況を確認してください。" : "まだログインを確認できません。別タブでログインしてから、もう一度確認してください。");
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="session-banner" role="alert">
      <p className="error-title">ログインの有効期限が切れました。</p>
      <p>入力中の内容はこの画面に残っています。別タブでログインしてから「ログインを確認」を押し、もう一度実行してください。</p>
      {message && <p>{message}</p>}
      <div className="action-row">
        <a className="button" href={loginPath(location.pathname + location.search)} target="_blank" rel="noopener">別タブでログイン</a>
        <button type="button" className="secondary-button" disabled={checking} onClick={() => void check()}>
          {checking ? "確認中..." : "ログインを確認"}
        </button>
      </div>
    </div>
  );
};

/**
 * Session復元。未ログインならログイン画面へ（戻り先を保持）、通信失敗はログイン画面と区別して再試行を出す。
 * ログイン後の操作で401 / CSRF不一致を受けたら`SessionLostBanner`を重ねる。
 */
export const AuthGate = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "anonymous" } | { kind: "network_error" } | { kind: "ready"; human: SessionHuman }>({ kind: "loading" });
  const [lost, setLost] = useState(false);

  const apply = useCallback((session: SessionInfo) => {
    setCsrfToken(session.csrfToken);
    setState({ kind: "ready", human: session.human });
    setLost(false);
  }, []);
  const load = useCallback(() => {
    setState({ kind: "loading" });
    fetchSession()
      .then(apply)
      .catch((error: unknown) => setState(error instanceof ApiError && error.status === 401 ? { kind: "anonymous" } : { kind: "network_error" }));
  }, [apply]);

  useEffect(() => {
    load();
    onSessionLost(() => setLost(true));
    return () => onSessionLost(null);
  }, [load]);

  const logout = useCallback(async () => {
    await request<unknown>(logoutPath, { method: "POST" }).catch((error: unknown) => {
      // 204は本文が無いためINVALID_RESPONSEになる。それ以外（通信失敗等）は呼び出し側へ返す。
      if (!(error instanceof ApiError && error.code === "INVALID_RESPONSE")) throw error;
    });
    setCsrfToken(null);
    setState({ kind: "anonymous" });
    navigate("/login", { replace: true });
  }, [navigate]);

  if (state.kind === "loading") return <Shell><main className="narrow"><Loading /></main></Shell>;
  if (state.kind === "anonymous") return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  if (state.kind === "network_error") {
    return (
      <Shell>
        <main className="narrow">
          <div className="state-card error" role="alert">
            <p className="error-title">サーバーに接続できませんでした。</p>
            <p>通信状況を確認して、もう一度お試しください。</p>
            <button type="button" className="secondary-button" onClick={load}>再試行</button>
          </div>
        </main>
      </Shell>
    );
  }
  return (
    <SessionContext.Provider value={{ human: state.human, logout }}>
      {lost && <SessionLostBanner onRestored={apply} />}
      {children}
    </SessionContext.Provider>
  );
};
