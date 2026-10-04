# Human認証・Membership・Credentialの現行仕様

## 責務と入口

HumanはGoogle OIDCで認証し、CompassのWeb SessionでWeb UIを操作する。Human Membership、Agent Role Grant、Runtime scopeは別の認可モデル。

| 主体 | 資格情報 | 認可 |
| --- | --- | --- |
| Human | Web Session Cookie | Project Membership |
| Agent | Agent CredentialのBearer | Project Role Grant |
| Runtime | Runtime CredentialのBearer | Project・scope |

Google依存はinfrastructureのIdentity Providerに閉じ、applicationは検証済みIdentityを受け取る。Human ActorとAgent Principalを型で区別する。

## 設定

| 環境変数 | 規則 |
| --- | --- |
| `COMPASS_AUTH_MODE` | 既定remote。remote / trusted-local |
| `COMPASS_PUBLIC_ORIGIN` | remoteではhttps originが必須 |
| `COMPASS_GOOGLE_CLIENT_ID` / `COMPASS_GOOGLE_CLIENT_SECRET` | remoteで必須 |
| `COMPASS_INITIAL_OWNER_EMAIL` | platform ownerが未作成なら必須 |
| `COMPASS_REGISTRATION_MODE` | closedのみ。既定closed |
| `COMPASS_HOST` | trusted-localではloopbackのみ、既定127.0.0.1 |

trusted-localは`NODE_ENV=production`で起動を拒否する。開発用の`POST /auth/local/login`はemailだけでログインするため、remoteでは公開しない。必要な設定が欠ける場合は起動時に拒否し、secretをエラーへ出さない。

Serverは起動ディレクトリの`.env`を読み込む。`PORT`はその前に確定するためシェルから渡す。テストがserverを子processで起動する場合も起動ディレクトリの影響を受ける。

## 登録・招待

本人識別の正本はprovider・issuer・subject。emailは表示と招待照合に使い、本人の一意識別には使わない。Googleの検証済みemailを要求する。

新規登録は初期owner、または有効な招待の宛先に限定する。初期ownerの作成後は設定emailをowner変更に使わない。platform ownerはMembershipを迂回する権限を持たない。owner不在ProjectへのMembership補完をログイン時に行う。

招待はownerが発行し、リンクを手渡す。メール送信はしない。有効期限は既定7日、1時間〜30日。同じ宛先の期限内pending招待の重複発行は409。期限切れpendingの再発行は古い招待を失効させる。招待先emailの検証、Membership作成、招待の受諾は同じtransactionで行う。

最後のownerを失うMembership変更・取消は`409 LAST_OWNER`。archived Projectでは招待・Membership変更を拒否する。owner不在Projectの補完は例外。

## Web Session・Cookie・CSRF・OIDCの契約

Sessionは発行から7日、無操作24時間で失効する。secretの平文は保存せずSHA-256を保存する。logoutと再ログイン時の旧Session失効を行う。

remoteのCookie名は`__Host-compass_session`で、Secure・HttpOnly・SameSite=Lax・Path=/・Domainなし。trusted-localのhttpでは`compass_session`を使う。

OIDCはstate / nonce / PKCEを検証し、ログイン試行の期限は10分。callbackは`${COMPASS_PUBLIC_ORIGIN}/auth/google/callback`。ログイン後のreturn先は同一originの相対pathのみ許可する。

Human向けWeb APIの変更操作はSession・一致するOrigin・`X-Compass-CSRF`を要求する。`GET /api/auth/session`がCSRF tokenとSession情報を返す。Session CookieをMCPやRuntime APIへ流用しない。

## 権限表（Human Role）

Role順序はowner > administrator > editor > viewer。

| 操作 | 最低Role |
| --- | --- |
| Project作成 | ログイン済み。作成者がownerになる |
| Project一覧 | 有効なMembershipを持つProjectのみ |
| Project・Direction・Execution・Member・Grant参照 | viewer |
| Intent・Outcome変更、Story / Task手動起票・編集、Task介入・Comment | editor |
| Project更新、Agent Grant、Credential管理 | administrator |
| archive、招待、Membership変更・取消 | owner |

## 認可の順序と応答

Sessionなしは401。未所属・取消済みMembership・存在しないProjectは404で区別しない。MembershipのRole不足は403。その後に入力・対象・archive・業務状態を検査する。

Membershipはrequestごとに読み、取消・Role変更を次の操作へ反映する。UIの表示制御に加えてserverが拒否を強制する。権限表の実装は [HumanAuth.ts](../packages/access/src/domain/HumanAuth.ts) にある。

## Agent・Runtime Credential

形式は`cmp_agent.<id>.<secret>` / `cmp_runtime.<id>.<secret>`。secretは256bit乱数で、DBはSHA-256だけを保持する。発行・rotation時に一度だけtokenを返す。期限切れ・取消・不正値は認証を拒否する。

Runtime scopeは`runtime:event:read` / `runtime:event:ack` / `execution:change:read` / `execution:evidence:write` / `execution:summary:read`。発行Projectとscopeを検査し、Agent Grantとは混同しない。

trusted-localではAgent名のBearerも許可するが、`cmp_`形式は常にCredentialとして検証する。remoteではAgent名の自己申告を許可しない。

## MCPの認証・認可適用表（remote mode）

| tool分類 | 契約 |
| --- | --- |
| Project作成・更新、Intent作成・更新・放棄 | 登録しない。HumanはWeb UIを使用 |
| Direction参照 | Agent Credentialと対象ProjectのGrantを要求 |
| Project一覧 | Grantのあるactive Projectだけを返す |
| `get_role_instructions` | 機密を含まない静的文書。認証不要 |
| Role専用tool | 必要なAgent Grantを検査 |
| Runtime用tool | Runtime CredentialのProject・scopeを検査 |

CLIのGrant操作はローカル保守・自動検証用。通常のHuman操作の代替としない。

## 保存と検証

Human関連tableは`human_user` / `human_identity` / `web_session` / `auth_login_attempt` / `project_membership` / `project_invitation`。Credentialは`access_credential`。ログイン・招待・権限変更の整合性はtransactionで保つ。

[humanAuthHttpIntegration.test.ts](../server/tests/humanAuthHttpIntegration.test.ts) はテスト用OIDC providerと実HTTP serverを使用する。実Google接続の検証とは区別する。既存テストのSession fixtureはテスト内に限定する。
