import { Link, useLocation, useNavigate } from "react-router-dom";
import { Shell } from "./Shell";

/** BrowserRouterが履歴に持つindex。0（直接開いた・新しいタブ）では戻り先がCompass内に無い。 */
const hasPreviousEntry = () => {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && "idx" in state && typeof state.idx === "number" && state.idx > 0;
};

/** 定義していないURL。ホーム（現在のWorkspace）と、Compass内の直前の画面へ戻る導線を出す。 */
export const NotFoundPage = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <Shell>
      <main className="narrow">
        <div className="state-card not-found">
          <p className="eyebrow">404</p>
          <h1>ページが見つかりません</h1>
          <p>URLが間違っているか、画面の場所が変わった可能性があります。</p>
          <p className="section-note">開いたURL: <code>{pathname}</code></p>
          <div className="action-row">
            <Link to="/" className="button">ホームへ</Link>
            {hasPreviousEntry() && <button type="button" className="secondary-button" onClick={() => void navigate(-1)}>直前の画面へ戻る</button>}
          </div>
        </div>
      </main>
    </Shell>
  );
};
