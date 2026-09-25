import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { request } from "../../api";
import { Shell } from "../../components/Shell";
import { Loading } from "../../components/StateCard";
import { loginErrorMessage, methodsPath, normalizeReturnTo, readInvitationToken, type AuthMethods } from "./auth";

/**
 * ログインのform。serverの`/auth/*`へ通常のform POSTで送る（Googleへの302をブラウザが辿るため、fetchにしない）。
 * 招待tokenは本文で送り、URLやaccess logへ残さない。
 */
const LoginForms = ({ returnTo, invitationToken }: { returnTo: string; invitationToken?: string }) => {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    request<AuthMethods>(methodsPath).then(setMethods).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  if (failed) {
    return (
      <div className="state-card error" role="alert">
        <p className="error-title">サーバーに接続できませんでした。</p>
        <p>通信状況を確認して、もう一度お試しください。</p>
        <button type="button" className="secondary-button" onClick={load}>再試行</button>
      </div>
    );
  }
  if (!methods) return <Loading />;
  const hidden = (
    <>
      <input type="hidden" name="returnTo" value={returnTo} />
      {invitationToken && <input type="hidden" name="invitationToken" value={invitationToken} />}
    </>
  );
  return (
    <div className="login-forms">
      {methods.google && (
        <form method="post" action="/auth/google/login">
          {hidden}
          <button className="button">Googleでログイン</button>
        </form>
      )}
      {methods.local && (
        <form method="post" action="/auth/local/login" className="grant-form local-login">
          {hidden}
          <p className="section-note">開発用ログイン（trusted-local）。Googleを使わず、メールアドレスだけでログインします。本番環境では使えません。</p>
          <label>
            メールアドレス <span>必須</span>
            <input name="email" type="email" required aria-required="true" autoComplete="email" maxLength={320} />
          </label>
          <div className="form-actions">
            <button className="secondary-button">開発用ログイン</button>
          </div>
        </form>
      )}
      {!methods.google && !methods.local && (
        <div className="state-card error" role="alert">ログイン方法が設定されていません。サーバーの設定を確認してください。</div>
      )}
    </div>
  );
};

/** serverからの`/login?error=`（not_allowed・invitation_expired・oidc_failed）を簡潔に表示し、フォーカスを移す。 */
const LoginError = ({ code }: { code: string | null }) => {
  const message = loginErrorMessage(code);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [code]);
  if (!message) return null;
  return (
    <div className="state-card error" role="alert" tabIndex={-1} ref={ref}>
      <p className="error-title">{message.title}</p>
      <p>{message.detail}</p>
    </div>
  );
};

export const LoginPage = () => {
  const [params] = useSearchParams();
  return (
    <Shell>
      <main className="narrow">
        <div className="detail-hero">
          <p className="eyebrow">Sign in</p>
          <h1>Compassにログイン</h1>
          <p className="lede">利用できるのは、許可されたアカウントと、Projectに招待されたアカウントだけです。</p>
        </div>
        <LoginError code={params.get("error")} />
        <LoginForms returnTo={normalizeReturnTo(params.get("returnTo"))} />
      </main>
    </Shell>
  );
};

/**
 * 招待リンク`/invite#<token>`。tokenはfragmentから読んだ後にアドレスバー・履歴から消す。
 * 受諾はログイン時にserverが、OIDCで検証したemailと招待先を照合して行う（tokenだけでは受諾できない）。
 */
export const InvitePage = () => {
  const [token] = useState(() => readInvitationToken(window.location.hash));
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);
  return (
    <Shell>
      <main className="narrow">
        <div className="detail-hero">
          <p className="eyebrow">Invitation</p>
          <h1>Projectへの招待</h1>
          <p className="lede">招待されたメールアドレスのアカウントでログインすると、Projectに参加できます。</p>
        </div>
        {token ? (
          <LoginForms returnTo="/" invitationToken={token} />
        ) : (
          <div className="state-card error" role="alert">
            <p className="error-title">招待リンクを読み取れませんでした。</p>
            <p>受け取った招待リンクを、もう一度そのまま開いてください。ページを再読み込みした場合も、リンクから開き直す必要があります。</p>
          </div>
        )}
      </main>
    </Shell>
  );
};
