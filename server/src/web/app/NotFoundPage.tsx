import { useLocation, useNavigate } from "react-router-dom";
import { StateCard } from "../components/StateCard";
import { Button, LinkButton } from "../components/ui";

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
    <main className="narrow not-found">
      <StateCard>
        <p className="eyebrow">404</p>
        <h1>ページが見つかりません</h1>
        <p>URLが間違っているか、画面の場所が変わった可能性があります。</p>
        <p className="section-note">開いたURL: <code>{pathname}</code></p>
        <div className="action-row">
          <LinkButton to="/">ホームへ</LinkButton>
          {hasPreviousEntry() && <Button variant="secondary" onClick={() => void navigate(-1)}>直前の画面へ戻る</Button>}
        </div>
      </StateCard>
    </main>
  );
};
