# Step 6: Human認証・Project Membership・招待制 設計

> **状態: 設計（確定、Task 39）。永続化（domain・repository・schema・application use case）はTask 40、Google OIDC・Web Session・`/auth/*`・`/api/auth/*`・CSRF検査・設定のfail-fastはTask 41で実装済み。既存のHuman向けWeb APIへのSession・Membership認可の適用はTask 42、ログイン・招待・Membership管理の画面はTask 43で実装済み。MCPのremote modeでのHuman Command非公開・匿名呼出しの制限はTask 42、Agent / Runtime Credentialによる認証・参照系のGrant検査はTask 37で実装済み（下記「実装記録（Task 37）」）。実HTTP統合検証と運用文書はTask 44で実施済み（下記「実装記録（Task 44）」）。**
> 事前のユーザー確認は設けない。親Storyに定めのない事項は、既存設計との整合、単純さ、将来の変更容易性を基準に初期値を選び、理由を「選択理由と将来変更できる箇所」に記録する。

## 根拠資料と優先順位

| 区分 | 資料 | 扱い |
| --- | --- | --- |
| 主根拠 | Wacha Story「Google OIDCでHumanを認証し、招待制Projectアクセスを実装する」（以下、親Story） | 要件・制約の正本 |
| 主根拠 | `AGENTS.md` | HumanはWeb UIが正規入口、AgentはMCP、CLIは保守用途、HumanがサーバーのfilesystemやSQLiteへ直接触れない |
| 補助 | `kit/docs/api-and-persistence.md` | 401 / 403 / 404 / 409の使い分け、「dev認証は明示フラグでのみ有効、productionでは起動拒否」、「cookie利用時のCSRF対策」 |
| 既存設計 | `docs/step-4-strategist-role-design.md`、`docs/step-5-project-archive-design.md`、`docs/lv6-unification-design.md` | Agent Principal・Role Grant・archive・Execution Web UI移行順（U5）の現行仕様 |

## 責務境界

| 主体 | 認証 | 認可 | 本書の対象 |
| --- | --- | --- | --- |
| Human | Google OIDC（本書）→ Compass発行のWeb Session Cookie | Project Membership + Human Role（owner / administrator / editor / viewer） | ○ |
| Agent | `Authorization: Bearer`（現行trusted-local。Task 37で不透明Credential） | Project Role Grant（strategist / researcher / manager / worker / reviewer / evaluator） | 境界の維持のみ |
| Runtime | `Authorization: Bearer`（現行は暫定runtime Grant。Task 37でRuntime Credentialのscope） | scope | 境界の維持のみ |

- **3種の資格情報を混同しない。** Web Session CookieはHuman向けルートでだけ読み、MCP・Runtime向けWeb API（`runtime-events`・`execution-evidence`）の認証には使わない。逆にBearerでHuman向けWeb APIを呼べない。
- **Human Membershipと Agent Grantは別table・別Role集合。** Human RoleをAgentのGrantとして扱わず、Agent GrantをHumanのMembershipとして扱わない。
- **Google依存は adapter に閉じる。** domain / applicationは `provider`・`issuer`・`subject`・`email`・`emailVerified` だけを持つ `VerifiedIdentity` を扱い、Google固有のclaim・型・URLを持たない。

### 層の配置

| 層 | 置くもの |
| --- | --- |
| domain | `HumanUser`、`HumanIdentity`、`WebSession`、`ProjectMembership`、`ProjectInvitation`、`HumanRole`、Role順序と権限表（純粋関数） |
| application | port `HumanIdentityProvider`（認可URL生成・callback検証）、port `Clock` / `SecretGenerator`（既存に無ければ）、use case（下記）、`HumanProjectAuthorizationService` |
| infrastructure | SQLite repository、`GoogleOidcIdentityProvider`（token交換・ID Token検証）、`LocalDevIdentityProvider`（trusted-local専用） |
| presentation | Honoの`/auth/*` route、Session解決middleware、CSRF middleware、Cookie入出力 |

Human向けapplication use caseは `HumanActor = { kind: "human"; humanUserId: string }` を第1引数に受け取る。既存のAgent用 `Principal`（文字列）とは型で区別し、同じ引数に混在させない。

## データモデル

すべて `initializeSchema` に `create table if not exists` で追加する（既存tableの再構築は不要）。時刻はepoch ms（既存と同じ）。IDはUUID。

### human_user

| 列 | 規則 |
| --- | --- |
| id | PK |
| display_name | 最後のログイン時のOIDC `name`（無ければemailのlocal part）。表示専用 |
| email | 最後に検証されたemail（小文字化）。**表示と招待照合の補助だけに使い、本人識別に使わない。unique制約を付けない** |
| platform_role | `owner` / `member`。`owner` は部分unique index（`where platform_role = 'owner'`）で最大1件 |
| status | `active` / `disabled`。disabledへの変更UIは初期版に作らない（保守の余地だけ残す） |
| created_at / updated_at | |

### human_identity

| 列 | 規則 |
| --- | --- |
| id | PK |
| human_user_id | FK → human_user |
| provider | `google` / `local`（trusted-local専用） |
| issuer | 正規化済み（Googleは `https://accounts.google.com` に統一） |
| subject | OIDC `sub` |
| email_at_login | 最後のログイン時のemail（表示・監査用） |
| created_at / last_login_at | |

- unique `(provider, issuer, subject)`: **本人識別の正本**。email変更で別Humanを作らない。
- unique `(human_user_id, provider)`: 初期版は1 Humanにつき1 providerあたり1 Identity。
- ProjectにGoogle `sub` を埋め込まない（`human_identity → human_user → project_membership`）。

### web_session

| 列 | 規則 |
| --- | --- |
| id | PK（内部ID。Cookieには入れない） |
| token_hash | Cookie値（256bit乱数、base64url）のSHA-256。unique。**平文は保存しない** |
| human_user_id | FK |
| created_at / last_seen_at | `last_seen_at` は5分以上経過したときだけ更新（書込を抑える） |
| expires_at | 絶対期限。発行から7日 |
| revoked_at / revoke_reason | `logout` / `human_disabled` / `superseded`（ログイン時に既存Sessionを失効） |

- 有効 = `revoked_at is null` かつ `now < expires_at` かつ `now < last_seen_at + 24h`（アイドル期限）。期限切れは行を更新せず判定で無効にする（Claimと同じ考え方）。
- CSRF tokenは保存しない。`HMAC-SHA256(key = Cookieのsession secret, "csrf")` をserverが都度計算する。

### auth_login_attempt（OIDCのstate / nonce / PKCE）

| 列 | 規則 |
| --- | --- |
| id | ログイン試行Cookie値（256bit乱数）のSHA-256 |
| provider | `google` / `local` |
| state | 認可要求の `state`（128bit以上の乱数） |
| nonce | ID Tokenの `nonce` 照合用 |
| code_verifier | PKCE（S256）。token交換にだけ使う |
| return_to | ログイン後の遷移先。**同一origin内の相対path**（`/` で始まり `//` と `\` を含まない）だけ保存し、それ以外は `/` |
| invitation_token_hash | 招待リンク経由のときだけ。招待tokenのSHA-256 |
| expires_at | 10分 |
| consumed_at | callbackで原子的に設定（`update ... where consumed_at is null`）。再利用は拒否 |

- callback後（成功・失敗とも）は `state` / `nonce` / `code_verifier` を消去する。期限切れ行の掃除はログイン開始時に行う（schedulerを持たない）。

### project_membership

| 列 | 規則 |
| --- | --- |
| id | PK |
| project_id | FK → project |
| human_user_id | FK → human_user |
| role | `owner` / `administrator` / `editor` / `viewer`（check制約） |
| created_at / updated_at | |
| created_by_human_user_id | 付与したHuman。bootstrap・orphan補完はnull |
| revoked_at / revoked_by_human_user_id | 取消。行は削除しない（監査） |

- 部分unique `(project_id, human_user_id) where revoked_at is null`: 有効Membershipは1件。取消後の再招待は新しい行。
- 「Projectに有効なownerが1件以上」は application層の同一transaction内で検査する（DB制約では表現しない）。

### project_invitation

| 列 | 規則 |
| --- | --- |
| id | PK |
| project_id | FK |
| email | 招待先（trim・小文字化。Gmailのドット等の正規化はしない） |
| role | 初期Role（owner / administrator / editor / viewer） |
| token_hash | 招待token（256bit乱数）のSHA-256。unique。平文は発行応答で一度だけ返す |
| status | `pending` / `accepted` / `revoked`。期限切れは状態を書き換えず `expires_at` で判定 |
| expires_at | 既定7日、指定可能範囲1時間〜30日 |
| created_by_human_user_id / created_at | |
| accepted_by_human_user_id / accepted_at | |
| revoked_by_human_user_id / revoked_at | |

- 部分unique `(project_id, email) where status = 'pending'`: 同じ宛先の未使用招待は1件。期限内の招待がある宛先への再発行は取消してから行う（上書きしない。`409 INVITATION_PENDING`）。
- 期限切れの `pending` がある宛先への再発行は、同じtransactionで期限切れ招待を `revoked`（取消者は発行者）にしてから新しい招待を保存する。これで一意制約を保ったまま再発行でき、古いtokenは受諾できない（Task 40で実装・テスト済み）。
- 招待はメール送信しない。発行時に表示されるリンク（`{PUBLIC_ORIGIN}/invite#<token>`）をownerが相手へ渡す。

## 状態遷移

| 対象 | 遷移 | 規則 |
| --- | --- | --- |
| Session | 発行 → 有効 → `revoked`（logout・Human無効化・再ログイン） / 期限切れ（判定のみ） | ログイン成功ごとに新規発行（Session fixation対策）。同じブラウザの旧Session Cookieがあれば `superseded` で失効 |
| Invitation | `pending` → `accepted` / `revoked` | 受諾は一度だけ（`update ... where status = 'pending' and expires_at > now`）。`accepted` / `revoked` からの遷移なし。期限切れの `pending` は受諾・取消とも不可。同じ宛先への再発行時にだけ `revoked` へ遷移する |
| Membership | 作成（Project作成・招待受諾・bootstrap補完）→ Role変更 → `revoked` | 最後のownerを失う変更・取消は `409 LAST_OWNER`。取消済みは復帰させず再招待 |
| HumanUser | `active` → `disabled` | 初期版はUI・APIなし。disabled時は全Session失効・ログイン拒否 |

- **archived Project（Step 5の参照専用規則）**: 招待の発行・取消、Membership のRole変更・取消は、書込と同一transactionで `isProjectArchived` を検査し `409 CONFLICT`（`projectStatus: "archived"`）で拒否する。archive前に発行された `pending` 招待は状態を変えずに残し、受諾できない（登録判定の事実 `projectArchived` を受諾と同一transactionで集める）。新規Humanは `not_allowed`（Project状態を漏らさない）で行を作らず、既存Humanはログインだけ成功して招待を `invalid` として扱う。一覧（Membership・招待）の参照は従来どおり可能。唯一の例外はplatform ownerのorphan補完（bootstrap時と各ログイン時）で、archivedのProjectも管理不能にしないためowner Membershipを付与する（Human操作ではなく移行処理）。Task 40で実装・テスト済み。

## 登録・ログインの規則（closed registration）

`registration mode` は `closed` だけを実装する（他の値は起動時エラー）。callbackでOIDC応答を検証したあと、次の順で判定する。**いずれの拒否でも human_user / human_identity / membership / session を作らない。**

| # | 条件 | 結果 |
| --- | --- | --- |
| 0 | `email_verified` が true でない | 拒否（`not_allowed`） |
| 1 | `(provider, issuer, subject)` のIdentityが存在し、Humanが `active` | ログイン成功。`display_name` / `email` / `email_at_login` / `last_login_at` を更新。招待tokenがあれば下記「既存Humanの招待受諾」 |
| 2 | Identity未登録、platform ownerが未作成、emailが `COMPASS_INITIAL_OWNER_EMAIL` と一致（小文字比較） | **bootstrap**: Human（`platform_role = owner`）+ Identity + orphan Project補完 + Session を同一transactionで作成。部分unique indexで同時実行でも1件に限る |
| 3 | Identity未登録、招待tokenがあり、招待が `pending`・期限内・emailが一致 | Human（`member`）+ Identity + Membership + 招待 `accepted` + Session を同一transactionで作成 |
| 4 | 上記以外 | 拒否 |

- **初期owner emailは #2 の照合にだけ使う。** platform owner作成後は設定値を読まない（設定を変えても別Humanをownerにしない。以後は保存済み `issuer + subject` が正本）。
- 招待の照合は、ログイン時にOIDCで検証済みのemailに対して行う。招待tokenを知っているだけでは受諾できない。
- **既存Humanの招待受諾**: #1で招待tokenがあり、`pending`・期限内・email一致なら、Membership作成と `accepted` を同一transactionで行う。既に有効なMembershipがあるProjectの招待は受諾せず `pending` のまま残し（Role変更はMembership管理で行う）、ログイン自体は成功させる。
- **拒否応答**: `/login?error=<code>` へ302し、画面は簡潔な文言だけを出す。`code` は `not_allowed`（未許可account・email未検証・email不一致・無効/使用済み/取消済み/archived Projectの招待をまとめる）、`invitation_expired`（期限切れ招待。リンク保持者に再発行依頼を促すため区別）、`oidc_failed`（Google側エラー・state / nonce不一致・token検証失敗・期限切れログイン試行）の3種。Project名・招待先email・Human有無は出さない。

### platform owner と orphan Project

- platform ownerは「最初にbootstrapされたHuman」を示す属性で、**Project Membershipを迂回する特権は持たない**（全Projectの閲覧・変更権は無い）。
- **orphan Project**: 有効なowner Membershipを持たないProject（移行前から存在するProject、または認証導入前後にMCP `create_project` で作られたProject）。bootstrap時と、platform ownerの各ログイン時に、orphan Projectへplatform ownerのowner Membershipを同一transactionで冪等に補完する。これで既存Project / Intent / Outcome / Grantを失わず、管理不能Projectを残さない。
- remote modeでは、MCPからProjectを作る経路をTask 37で塞ぐ（下記「MCPの認証・認可適用表」）。塞いだ後も、補完は安全網として残す。

## Web Session・Cookie・CSRF・OIDCの契約

### 設定

| 環境変数 | 必須 | 規則 |
| --- | --- | --- |
| `COMPASS_AUTH_MODE` | 任意（既定 `remote`） | `remote` / `trusted-local`。Task 37のAgent Credentialと同じ値を共有する。`NODE_ENV=production` のとき `trusted-local` は起動拒否 |
| `COMPASS_PUBLIC_ORIGIN` | remoteで必須 | 例 `https://compass.example.com`。remoteでは `https:` 以外を起動拒否。redirect URIは `${COMPASS_PUBLIC_ORIGIN}/auth/google/callback` に固定し、requestのHostから組み立てない |
| `COMPASS_GOOGLE_CLIENT_ID` / `COMPASS_GOOGLE_CLIENT_SECRET` | remoteで必須 | secretはログ・エラーへ出さない |
| `COMPASS_INITIAL_OWNER_EMAIL` | platform owner未作成なら必須 | 作成後は不要（読まない） |
| `COMPASS_REGISTRATION_MODE` | 任意（既定 `closed`） | `closed` 以外は起動拒否 |
| `COMPASS_HOST` | 任意 | listenするhost（Task 41で追加）。`trusted-local` の既定は `127.0.0.1` でloopback以外は起動拒否。`remote` の既定は全interface |

- remoteで必須値の欠落・不正があれば起動時にfail-fastする（エラーにsecret値を含めない）。
- `trusted-local` は `NODE_ENV` が `production` でなく、かつloopback（`127.0.0.1` / `::1` / `localhost`）にbindする場合だけ起動を許す。productionの判定は `NODE_ENV=production` とする（kitの「dev認証はproductionで起動拒否」。loopback bindでもリバースプロキシ経由で到達できるため、bind先だけでは判定しない）。この場合に限り `LocalDevIdentityProvider`（`POST /auth/local/login`、emailだけで `provider = local`・`issuer = urn:compass:local` のIdentityとして扱う）を有効にする。registrationの規則（初期owner・招待）はGoogleと同じで、Googleの `(provider, issuer, subject)` とは混ざらない。remoteではrouteを登録しない。

### Cookie

| Cookie | 値 | 属性 |
| --- | --- | --- |
| `__Host-compass_session`（remote） / `compass_session`（trusted-local, http） | session secret（256bit, base64url） | HttpOnly、Secure（remote）、SameSite=Lax、Path=/、Domainなし、Max-Age=7日 |
| `__Host-compass_login` / `compass_login` | ログイン試行secret | HttpOnly、Secure（remote）、SameSite=Lax、Path=/、Max-Age=10分。callbackで削除 |

- SameSite=Lax: Googleからのcallbackはtop-levelのGET遷移で、Strictではlogin Cookieが送られないため。状態変更はGETで行わず、CSRFは下記で防ぐ。

### エンドポイント

| 経路 | 用途 | 規則 |
| --- | --- | --- |
| `POST /auth/google/login`（form: `returnTo?`, `invitationToken?`） | ログイン開始 | Origin検査。login attemptを作りCookieを発行して、Googleの認可endpointへ302。`response_type=code`、`scope=openid email profile`、`state`、`nonce`、`code_challenge`（S256）、`prompt=select_account`。`access_type=offline` を付けない（refresh tokenを要求しない） |
| `GET /auth/google/callback?code&state` | callback | login Cookie → attempt（未使用・期限内）→ `state` 一致 → server側でcode交換（`client_secret` + `code_verifier`）→ ID Token検証 → 登録規則 → Session発行 → `return_to` へ302 |
| `POST /auth/local/login` | trusted-local専用 | 上記と同じ登録規則・Session発行 |
| `GET /api/auth/session` | Session復元 | 有効なら `{ human: { id, displayName, email }, csrfToken, expiresAt }`、無ければ401 |
| `POST /api/auth/logout` | logout | CSRF必須。Sessionを `revoked`（`logout`）にしCookieを削除。Sessionが無くても204（冪等） |

- 招待tokenはURL fragment（`/invite#<token>`）で受け渡し、SPAがformの本文で `/auth/google/login` へPOSTする。fragmentはserverへ送られないため、access logに残らない。
- `/auth/google/callback` のquery（`code` / `state`）はrequest logに出さない（loggerでquery文字列を伏せる）。
- **ID Token検証**（Task 41）: GoogleのJWKSで署名（RS256）、`iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}、`aud` = client ID、`exp` > now（許容skew 60秒）、`iat` が未来でない、`nonce` = attemptのnonce、`email_verified = true`。JWKSは `Cache-Control` に従いcacheし、未知 `kid` で1回だけ再取得する。検証ライブラリは採用しない（Task 41）: RS256だけを受け付けるため、`node:crypto` のJWK読込（`createPublicKey({ format: "jwk" })`）とRSA署名検証で足り、本番依存を増やさない。
- Google access token / ID tokenは検証後に破棄し、DB・ログ・エラー・応答へ出さない。refresh tokenは要求しない。

### CSRF

Session Cookieで認証する `/api/*` の非安全method（POST / PATCH / PUT / DELETE）は、次をすべて満たさなければ `403 CSRF_REJECTED`:

1. `X-Compass-CSRF` headerが `GET /api/auth/session` で得た `csrfToken` と一致（定数時間比較）。
2. `Origin` headerが `COMPASS_PUBLIC_ORIGIN` と一致。`Origin` が無い場合は `Sec-Fetch-Site: same-origin` を要求する。

- Human向け `/api/*` からCORSの `origin: "*"` を外す（Cookie認証のrouteに他originからの呼出しを許さない）。Runtime向けAPIのCORSはTask 37で判断する。
- `/auth/google/login` はOrigin検査だけ行う（Session確立前のため `csrfToken` が無い）。

### 認証エラー

| 状況 | 応答 |
| --- | --- |
| Session Cookie無し・未知・期限切れ・取消済み | `401 UNAUTHENTICATED`（区別しない）。UIはログイン画面へ遷移し、入力中の内容を破棄しない（Task 43） |
| CSRF不一致 | `403 CSRF_REJECTED` |
| Human `disabled` | `401 UNAUTHENTICATED`（Sessionは失効済み） |

## 権限表（Human Role）

Role順序: `owner` > `administrator` > `editor` > `viewer`。「最低Role」以上が許可される。

| 分類 | 操作（use case / Web API） | 最低Role | 備考 |
| --- | --- | --- | --- |
| Platform | Session取得・logout | 認証済み | Membership不要 |
| Platform | Project作成 `CreateProjectUseCase` / `POST /api/projects` | 認証済み | 作成者を同一transactionでowner Membershipにする |
| Platform | Project一覧 `ListProjectsUseCase` / `GET /api/projects[?status=]` | 認証済み | **有効なMembershipを持つProjectだけ**を返す（active / archivedの絞り込みは既存どおり） |
| Project参照 | `GET /api/projects/:projectId` | viewer | |
| Project参照 | Intent一覧・詳細、Outcome一覧・詳細、Research Request一覧・詳細、Direction Decision一覧、ADR参照一覧、Execution Summary、Outcome Evaluation一覧（Task 45） | viewer | 既存のGET全般 |
| Project参照 | Agent Grant一覧 `GET .../grants` | viewer | secretを含まない |
| Project参照 | Membership一覧 `GET .../members` | viewer | 他Memberのemailを含む（同じProjectの協力者として必要） |
| Project参照 | Execution閲覧（U2: Story / Task / Change / Comment） | viewer | Task 45で実装（`GET ./execution`・`./tasks/:taskId`・`./changes`）。archived Projectも参照可 |
| Direction変更 | Intent作成・更新・放棄 | editor | |
| Direction変更 | Outcome作成・更新・取消（Human入口） | editor | |
| Execution介入 | Task受入・差戻し・取消・Comment（U3）、Story / Task手動起票・編集（U4） | editor | 未実装。実装時にこの行を適用 |
| Project管理 | Project更新 `PATCH /api/projects/:projectId` | administrator | Mission / Vision / Principles / Constraints / Repositories / Resources |
| Project管理 | Agent Role Grant発行・取消 | administrator | |
| Project管理 | Agent / Runtime Credential発行・rotation・取消・一覧（Task 37） | administrator | secretは発行時に一度だけ表示 |
| Project管理 | Project archive `POST .../archive` | owner | 不可逆のため |
| Membership | 招待の発行・一覧・取消 | owner | 招待Roleはownerを含む4種 |
| Membership | Membership Role変更・取消 | owner | 最後のowner保護 |

- **Runtime向けWeb API**（`GET .../runtime-events`、`POST .../runtime-events/:eventId/ack`、`POST .../outcomes/:outcomeId/execution-evidence`）はHuman向けではない。Session Cookieでは認可せず、Bearer（Task 37ではRuntime Credential）だけを受け付ける。
- 自己昇格の防止: Role変更はownerだけが行える。administrator以下は自分・他人のRoleを変えられない。ownerが自分を降格するのは、他に有効なownerがいる場合だけ許す。
- 退出（自分のMembership取消）は初期版では提供しない（ownerによる取消で代替）。

### 認可の順序と応答

1. Session解決（無ければ `401`）。
2. `HumanProjectAuthorizationService.requireProjectRole(actor, projectId, minimumRole)`: 有効なMembershipが無い（未所属・取消済み・**Projectが存在しない**）→ `404 NOT_FOUND`（存在を区別しない）。Membershipはあるが不足 → `403 FORBIDDEN`（`requiredRole` を含む）。
3. 既存のuse caseの検証（子IDが別Projectなら従来どおり `404`、archivedなら `409 CONFLICT`、入力不正は `400`）。

- Agent Grantの「Grant無しは `403`」（Step 4）とHuman Membershipの「未所属は `404`」は異なる。Agent向けMCPは既存契約を変えず、Human向けは存在を漏らさない方を選ぶ（Storyの「Project IDの存在を不要に漏らさず」）。
- 検査はMembershipを毎回DBから読む。Role変更・取消は次のrequestから反映される（Sessionは失効させない。SessionはProjectに依存しないため）。
- 権限表はdomainの1箇所（操作 → 最低Role）に置き、Web routeやUIに重複させない。UIは `GET /api/projects/:projectId` の応答に `myRole` を加えて導線の表示だけを切り替え、拒否は常にserverが行う。

### 最後のowner保護

- Role変更・Membership取消で、そのProjectの有効なowner数が0になる操作は `409 LAST_OWNER` で拒否する。検査と更新は同一transaction（SQLiteの書込transactionで直列化される）。
- 招待の取消・期限切れはowner数に影響しない。

## MCP・CLIとの関係

- **MCPにHuman Membershipを適用しない。** 既存のRole専用toolのGrant検査は変えない。remote modeで変える点は下記の適用表に限る。
- **MCPのHuman相当tool**: 現行の`/mcp`には、Grant不要で呼べるtoolがある（`create_project`・`list_projects`・`get_project`・`list_intents`・`get_intent`・`list_outcomes`・`get_outcome`・`list_adr_references`）。`update_project` / `create_intent` / `update_intent` / `abandon_intent` も、Direction系Roleの「拒否」だけを検査しており、匿名で実行できる。Web APIにMembership認可を適用しても、同じuse caseへMCPから匿名で到達できれば迂回路になる。remote modeの扱いを次のとおり決める。これは`AGENTS.md`の「未決定は小さな初期選択を行い、理由を記録する」に従う初期選択で、Manager受入時に確認を受ける。
- **CLI**（`grant` / `revoke` / `grants`）は保守用途として残し、Human Actorを要求しない（サーバー上のshellに入れる運用者の障害復旧用）。Human登録・招待・Membership変更のCLIは作らない。ownerがGoogle accountを失った場合の復旧手段（保守CLIでのowner付与等）は対象外とし、必要になった時点で別Taskにする。

### MCPの認証・認可適用表（remote mode）

`/mcp` 全体の前提: remote modeでは、有効なAgent CredentialまたはRuntime Credential（Task 37）の無い呼出しを、`get_role_instructions` を除く全toolで `UNAUTHENTICATED` として拒否する。Web Session Cookieは`/mcp`で読まない（Human Membershipは適用しない）。

| 区分 | tool | remote mode | trusted-local | 理由 |
| --- | --- | --- | --- | --- |
| Human管理Command | `create_project`、`update_project` | **登録しない**（`tools/list` に出さず、呼出しは未知tool） | 現行どおり | Project作成・構想更新はHumanの管理操作で、Web UIが正規入口。作成者のowner Membershipを作れないMCP経路はorphan Projectを生む |
| Human入力Command | `create_intent`、`update_intent`、`abandon_intent` | **登録しない** | 現行どおり | IntentはHumanの意図で、Web UIが正規入口（Task 38も「Web UI相当のIntent投入」）。Agent用の公開は、必要になった時点で専用Roleを定めて別Taskにする |
| Direction参照 | `get_project`、`list_intents`、`get_intent`、`list_outcomes`、`get_outcome`、`list_adr_references` | Agent Credentialで解決したPrincipalが、対象Projectに**いずれかのRole Grant**を持つ場合だけ許可（無ければ `FORBIDDEN`） | 現行どおり（Grant不要） | Agentは担当Projectの構想・Intent・Outcomeを読む必要があるが、Grantの無いProjectを読ませない |
| Project一覧 | `list_projects` | Principalが**Grantを持つProjectだけ**を返す | 現行どおり（全件） | Human側の「所属Projectだけ」と同じ考え方をGrantで適用する |
| 静的文書 | `get_role_instructions` | 認証不要のまま | 現行どおり | 機密を含まない静的文書。Agentの起動直後に読む |
| Role専用tool | Strategist・Researcher・Evaluator・Runtime用の既存tool、Task 33で移植するExecution tool（manager / worker / reviewer） | 既存のRole Grant検査を維持（Runtime用はTask 37でscope検査へ置換） | 現行どおり | 既存契約を変えない |

- Human向けのuse caseを、Human Actorを持たないMCP経路から呼ばない。`CreateProjectUseCase` のActor無し版は、trusted-localのMCPとテスト・保守用途だけに残す。
- trusted-localは明示設定・loopback bind限定（上記「設定」）のため、現行の匿名toolを残しても`AGENTS.md`のremote配置の前提に反しない。
- **実装の担当**: MCPの認証・参照系のGrant検査は**Task 37**（Credentialを実装するTaskのため）。remote modeでのHuman Command非登録と匿名呼出しの制限は、Task 42のレビュー差戻しを受けてTask 42で実装した。Web API側の認可はTask 42。Task 42は、Web APIで塞いだ各Commandに対応するMCP toolが、remote modeで登録されていないか匿名で拒否されることを回帰テストで確認する。Task 44は、実HTTP serverで`/mcp`へ匿名で`tools/list`と各Human相当toolを呼び、拒否されることを確認する。

## 既存データ・既存APIの移行

- **schema**: 新table（human_user、human_identity、web_session、auth_login_attempt、project_membership、project_invitation）と索引を冪等追加する。`project` / `project_grant` 等の既存tableは変更しない。
- **既存Project**: 移行時点ではowner不在（orphan）。初期ownerのbootstrap時にplatform ownerのowner Membershipを補完する（上記）。bootstrap前はだれも参照できないが、データは失われない。
- **既存Web API**: Task 42の適用後、Human向け `/api/*` は全てSessionを要求する（trusted-localでもLocalDevIdentityProviderでログインする）。匿名で呼べるのは `/health`・`/api`（生存確認）・`/api/auth/session`（401を返すだけ）・`/auth/*` だけ。
- **既存テスト**: 匿名で `/api/*` を呼ぶテストは、テスト用のSession fixture（repositoryへ直接Human・Membership・Sessionを作るhelper）へ移す。本番経路でのOIDC検証の省略はしない（fixtureは `HumanIdentityProvider` portの差し替えとtest helperに限定し、envで選べるようにしない）。

## 実装単位（Task 40〜44への分割）

| Task | 範囲 | 主なもの |
| --- | --- | --- |
| 40 永続化 | domain・repository・schema・use case（Web / Googleなし） | 上記6 table。`RegisterOrLoginHumanUseCase`（登録規則 #0〜#4・bootstrap・orphan補完・招待受諾を、検証済み `VerifiedIdentity` から1 transactionで実行）、`IssueSession` / `ResolveSession` / `RevokeSession`、`CreateProjectUseCase` のowner Membership同時保存（Actor付き版）、`ListMembers` / `ChangeMemberRole` / `RevokeMember`（最後のowner保護）、`CreateInvitation` / `ListInvitations` / `RevokeInvitation`。token平文を保存しないこと、再起動後の保持をtestで確認 |
| 41 OIDC・Session | adapter・`/auth/*`・Cookie・CSRF middleware・設定のfail-fast | `GoogleOidcIdentityProvider`、`LocalDevIdentityProvider`、login attempt、logout、`GET /api/auth/session`、loggerのquery伏せ字 |
| 42 認可適用 | `HumanProjectAuthorizationService`、権限表、既存Web APIへの適用、`myRole` | 全routeにActorを渡す。一覧のMembership絞り込み。Runtime APIとの分離。既存テストのfixture移行。Web APIで塞いだCommandがremoteのMCPから匿名で実行できないことの回帰テスト（Task 37の実装に依存） |
| 43 UI | ログイン画面・`/invite`・Session復元・logout・アクセス拒否表示・Membership / 招待管理画面 | `/login?error=` の3種の表示。招待リンクの一度だけの表示とコピー |
| 44 統合検証・文書 | 実HTTP server・OIDC fixture（JWKSとtoken endpointを持つテスト用provider）での通し検証、README・`.env.example` | Cookie属性、CSRF、open redirect、Session fixation、秘密の非露出、既存DBのorphan補完。招待の期限切れ再発行（古いtokenは受諾不可）と、同じ宛先への並行発行（1件だけ成功し、他は`409 INVITATION_PENDING`）。`/mcp`への匿名呼出しの拒否 |

## 実装記録（Task 41）

- **配置**: port `HumanIdentityProvider`（`src/application/port`）、`GoogleOidcIdentityProvider`（`src/infrastructure/identity`。token endpoint・JWKSとfetchは自動テストのOIDC fixtureへ差し替えるためだけにconstructorで注入でき、envからは選べない）、`SQLiteLoginAttemptRepository`、use case `StartOidcLoginUseCase` / `CompleteOidcLoginUseCase` / `LocalDevLoginUseCase`、route・Cookie・CSRF検査 `src/presentation/http/registerHumanAuthRoutes.ts`、設定 `src/presentation/http/humanAuthConfig.ts`。`LocalDevIdentityProvider` は独立したadapterにせず、emailから `provider = local` の `VerifiedIdentity` を作る `LocalDevLoginUseCase` で実装した（外部通信が無く、adapterを分ける必要がないため）。
- **callback**: ログイン試行を先に使用済みにし（state / nonce / code_verifierを同時に消去）、その後でIdPの `error`・state・code交換・ID Tokenを検査する。どこで失敗しても同じ試行は再利用できない。
- **email_verified**: ID Token検証では値を `VerifiedIdentity.emailVerified` へ写すだけにし、`false` は登録規則 #0 で `not_allowed` にする（拒否理由の表に合わせるため。`oidc_failed` にはしない）。
- **Session解決・CSRF**: `requireHumanSession`（Session無しは `401`、非安全methodは `X-Compass-CSRF` とOrigin / `Sec-Fetch-Site` を検査し不一致は `403 CSRF_REJECTED`）を `GET /api/auth/session`・`POST /api/auth/logout` で使う。既存の `/api/*` への適用とCORS `origin: "*"` の除去はTask 42。
- **request log**: Honoの `logger` はqueryを含めて出力するため、`/auth/*` のquery文字列を `?[redacted]` に置き換える。
- **起動**: `src/server.ts` は `loadHumanAuthConfig` で設定を検査してからDBを開き（`NODE_ENV=production` の `trusted-local` はここで拒否する。レビュー差戻し対応）、platform owner未作成で `COMPASS_INITIAL_OWNER_EMAIL` が無ければ起動を拒否する。`createApp` は `humanAuth` optionを受け取ったときだけ認証routeを登録する（既存テストの `createApp(services)` は従来どおり）。
- **未接続・未検証**: 実Googleとの接続は未検証（自動テストは本番の `GoogleOidcIdentityProvider` にOIDC fixtureのtoken endpoint・JWKSを注入して検証）。ログイン画面・`/invite` はTask 43。

## 実装記録（Task 42）

- **権限表**: domain `humanProjectPermissions`（`src/domain/model/HumanAuth.ts`。操作 → 最低Role）が唯一の表。`HumanProjectAuthorizationService.authorize(actor, projectId, operation)` がこの表で検査し、Membership・招待のuse caseも同じ表を使う。操作は `project.read`（Project・Intent・Outcome・Research・Direction Decision・ADR参照・Execution Summaryの参照）、`grant.read`、`member.read`（viewer）、`direction.write`（editor。Intent / Outcomeの作成・更新・放棄・取消）、`project.update`、`grant.manage`（administrator）、`project.archive`、`invitation.manage`、`member.manage`（owner）。
- **application層**: `HumanAuthorizedUseCase`（`src/application/usecase/HumanProjectUseCases.ts`）が、Membership認可を通してからMCPと共通の既存use caseへ委譲する。業務規則（archived・子IDの所属・入力検証）は委譲先の1箇所のまま。`ListHumanProjectsUseCase` は有効なMembershipのProjectだけを返し、`GetHumanProjectUseCase` は `{ project, myRole }` を返す。Web routeは `services.human.*` だけを呼び、MCPは従来の（Actorを持たない）use caseを呼ぶ。
- **Web API**: Human向け `/api/*` は全て `requireHumanSession` を通る。`createApp` に `humanAuth` が渡されない場合（MCP等のテスト）も検査は省かず、trusted-localのCookie名・`http://localhost` のoriginで検査する（認証routeは登録しないため、Sessionは作れない）。Membership・招待のrouteを追加した: `GET /api/projects/:projectId/members`、`PATCH|DELETE .../members/:membershipId`（本文 `{ role }`）、`GET|POST .../invitations`、`DELETE .../invitations/:invitationId`。招待の発行応答は `{ invitation, invitationUrl }`（`{PUBLIC_ORIGIN}/invite#<token>`、`Cache-Control: no-store`）で、tokenは一覧に含めない。
- **CORS**: `origin: "*"` は Bearer で呼ぶ `/mcp`・`runtime-events`・`execution-evidence` にだけ付け、Human向け `/api/*` には付けない（Runtime向けの扱いの見直しはTask 37）。
- **Step 5との順序**: Web APIでは、存在しないProjectへのarchive等は入力検証より先にMembership認可で `404` になる（Step 5のAC-4「入力検証は存在確認より先」はuse case単体・MCP・CLIでの順序として維持）。
- **既存テスト**: `test/support/humanSession.ts` のfixture（DBへHuman・Sessionを直接作る。OIDC検証は省略しない本番経路とは別）へ移行した。既存テストのappは、owner不在のProjectへfixtureのHumanのowner Membershipを補う（platform ownerのorphan補完に相当）。
- **MCP（レビュー差戻し対応）**: `createMcpServer` は `createApp` の `humanAuth.mode` を受け取る。remote modeでは適用表のHuman管理・入力Command（`create_project`・`update_project`・`create_intent`・`update_intent`・`abandon_intent`）を登録せず、Authorization無しの呼出しには `get_role_instructions` だけを登録する（他toolは未知toolとして拒否。`UNAUTHENTICATED` への置換はTask 37で可）。trusted-localは従来どおり。回帰テストは `test/remoteMcpHumanCommands.test.ts`（匿名・Bearer付きのtools/list、各Commandの拒否とDB不変、trusted-localの登録維持）。
- **Task 37で解消**: remote modeのAgent名自己申告は `401` で拒否し、Agent Credentialの検証、参照系のGrant検査、`list_projects` のGrant絞り込み、Agent / Runtime Credential管理のWeb API（`administrator`）を実装した（下記「実装記録（Task 37）」）。Web UIのSession復元・CSRF header付与・ログイン画面はTask 43で実装した。
- **Credential管理の認可（再差戻し対応）**: Credential管理のuse caseはTask 37で実装され、同じ権限表の `credential.manage`（administrator）で認可する。Task 42では、この認可が他のHuman向けAPIと同じ規則で働くことを `test/humanWebAuthorization.test.ts` の回帰テストで確認する。対象は次のとおり。
  - editor・viewerは一覧・発行・rotation・取消が `403`（`requiredRole` 付き）。administrator・ownerは許可。
  - 未所属Project、取消済みMembership、自分のProjectのURLに別ProjectのCredential IDを混ぜた呼出しは `404`。
  - CSRF tokenの無い発行は `403`。拒否された操作ではCredentialが変わらない。
  - application層では、入力検証より先に認可する。

## 実装記録（Task 43）

- **配置**: `src/frontend/features/auth`（`LoginPage` / `InvitePage` / `AuthGate` / `useSession`、純関数は `auth.ts`）、`src/frontend/features/member`（`MembershipSection`、純関数は `members.ts`）、`src/frontend/permissions.ts`。UIの導線の出し分けはdomainの `humanProjectPermissions` を `canOperate(myRole, operation)` で参照し、権限表をUIに重複させない。拒否は常にserver。
- **ログイン**: `/login` はGoogle（`POST /auth/google/login`）と、trusted-localだけの開発用ログイン（`POST /auth/local/login`）を通常のform POSTで出す。どちらを出すかは追加した `GET /api/auth/methods`（`{ google, local }`。設定値・secretは返さない）で決める。`/login?error=not_allowed|invitation_expired|oidc_failed` をそれぞれ区別して表示し、Project名・招待先email・Humanの有無は出さない。`returnTo` は同一originの相対pathだけを使う（serverも同じ規則で検査する）。
- **招待リンク**: `/invite#<token>` はfragmentからtokenを読んだ後、`history.replaceState` でアドレスバー・履歴から消し、ログインformの本文（`invitationToken`）でだけ送る。受諾はserverがOIDC検証済みemailと招待先を照合して行う。
- **Session**: `AuthGate` が `GET /api/auth/session` でSessionを復元し、CSRF tokenを `api.ts` へ設定する（非安全methodだけ `X-Compass-CSRF` を付ける）。未ログインは戻り先付きで `/login` へ、通信失敗はログイン画面と区別して再試行を出す。操作中の `401` / `403 CSRF_REJECTED` は画面を差し替えずにbannerを重ね、別タブでの再ログインと「ログインを確認」を促す（入力を失わない）。bannerは表示時にfocusを受け（同じ失敗でfocusを取るフォームのエラー要約より後）、閉じると直前の要素へfocusを戻す。`403 FORBIDDEN` は権限不足として区別する。logoutはheaderから行う。
- **Membership画面**: Project詳細にMember一覧（viewer以上）を置き、ownerだけにRole変更・取消・招待（email・Role・有効期限1時間〜30日）・招待取消を出す。招待リンクは発行直後だけ表示・コピーできる。最後のownerのRole変更・取消は導線を無効にし、serverの `409 LAST_OWNER` も日本語で表示する。期限切れの招待は `pending` と期限から「期限切れ」と表示する。自分のRoleを変えた後は `myRole` を読み直す。Project編集・archive・Intent / Outcome・Agent Grantの導線も `myRole` で出し分ける。Intent / Outcome詳細（子画面）は `useProjectOperation(projectId, "direction.write")`（`src/frontend/useProjectAccess.ts`）でProjectのstatusと `myRole` から判定し、viewerとarchivedでは編集・放棄・取消・Outcome登録の導線を出さない（editor以上は表示。administratorは権限表の順序でeditorの操作を含む）。作成・編集画面（Intent・Outcomeの登録・編集は `direction.write`、Project編集は `project.update`）は `ProjectOperationGate`（`src/frontend/components/ProjectOperationGate.tsx`）で包み、URLを直接開いた場合も判定できるまでフォームを描画しない。判定結果は対象の `projectId`・`operation` と組で保持し、同じ画面のままProject IDが変わった最初のrenderから前のProjectの結果を使わず取得中として扱う（`currentProjectOperationResult`）。archivedは「アーカイブ済みのProjectは変更できません」、Role不足は「権限がありません」、未所属・存在しないProjectは「Projectが見つかりません」を戻り先のリンクとともに表示する（文言と判定は `src/frontend/projectAccess.ts`）。serverの `403` / `409` はそのまま維持する。
- **検証**: 純関数（CSRF付与、Session切れ・権限不足・409の分類、戻り先の正規化、招待token・状態、最後のowner判定）を `test/membershipUi.test.ts` で、`/api/auth/methods` を `test/humanOidc.test.ts` で確認した。trusted-localの実serverで、開発用ログイン・Session復元・Project作成・招待発行・招待リンクによる受諾・未許可accountの拒否・logoutをHTTPで確認した。
- **画面検証（差戻し対応）**: trusted-localの実server（空DB）とheadless Chrome（DevTools Protocol）で次を確認した（検証scriptはリポジトリに含めない）。
  - Role別導線: viewer / editor / administrator / ownerでProject詳細・Intent詳細・Outcome詳細を開き、viewerでは編集・放棄・取消・Outcome登録・Intent編集の導線が無く、editor / administrator / ownerでは表示されること。Member管理（招待・Role変更・取消）はownerだけに表示されること。archived Projectではownerでも書込導線が無いこと。
  - Member管理: 幅1200px・375pxで招待フォーム・一覧・Role変更が表示され、label無しの入力要素と横スクロールが無いこと。最後のownerの操作が無効であること。Tabだけで招待emailへ到達でき（focus outline表示）、Tab・Enterで招待を発行すると発行済みリンク欄へfocusが移ること。重複招待（`409`）は日本語のエラー要約へfocusが移り、入力が残ること。
  - Session切れ: 招待入力中にCookieを失い送信すると、bannerが出てfocusがbannerへ移り、Tabで「別タブでログイン」「ログインを確認」へ進めること。未ログインのまま確認すると案内が出てbannerが残ること。再ログイン後の確認でbannerが閉じ、入力を保ったまま新しいCSRF tokenで再送できること。375pxで横スクロールが無いこと。
- **画面検証（2回目の差戻し対応: URL直アクセス）**: 同じ構成（trusted-localの実server、headless Chrome + DevTools Protocol、検証scriptはリポジトリに含めない）で49項目を確認した。
  - viewer / editor / administrator / ownerそれぞれで、active・archivedのProjectについてIntent登録・Intent編集・Outcome登録・Outcome編集・Project編集のURLを直接開いた。active ProjectではviewerはすべてRole不足の表示でフォーム無し、editorはIntent・Outcomeのフォームを表示しProject編集はRole不足、administrator・ownerはすべてフォームを表示した。archived ProjectではすべてのRole・画面でアーカイブ済みの表示になりフォームが無い。存在しないProject IDは「Projectが見つかりません」になる。
  - 375pxで、拒否表示（viewerのOutcome編集・ownerのarchived Intent登録）とeditorのIntent編集フォームに横スクロールが無い。拒否表示ではTabでheaderの後に戻り先リンクへ到達し（outline 3px）、Enterで詳細画面へ戻れ、viewerの詳細画面には編集・取消の導線が無い。
- **画面検証（3回目の差戻し対応: 同一route内のProject切替）**: 同じ構成で、同じ作成・編集画面のままURLのProject IDだけをクライアント内で切り替えた（`history.pushState` と `popstate`）。検証用Userは Project A（editor・active）、B（viewer・active）、C（editor・archived）、D（owner・active）を持つ。遷移開始からMutationObserverと遷移直後・次frameの観測で、「formがあり、main内のリンクが遷移先Projectを指す」状態（遷移先Project用のフォーム描画）が一度でも現れたかを記録した。
  - Intent登録: A→B・A→Cではフォームが一度も描画されずRole不足・アーカイブ済みの表示になり、B→A・C→Aではフォームが表示される。Project編集: D→B・D→A・D→Cではフォームが描画されず拒否表示になり、B→Dではフォームが表示される。幅1200px・375pxの両方で16/16成功、横スクロール無し。
  - 修正前の実装で同じ検証を行うと、Intent登録のA→B・A→Cで遷移先Project用のフォームが描画されることを検出した（Project編集はフォーム自身がProjectの読込中表示になるため顕在化しなかった）。
- **未検証**: 実Googleとの接続（Task 44でも未検証。「実装記録（Task 44）」参照）。スクリーンリーダーでの読み上げは確認していない。

## 実装記録（Task 44）

- **検証の構成**: `test/humanAuthHttpIntegration.test.ts`。`src/server.ts` と同じ手順（`loadHumanAuthConfig` → `initializeSchema` → services → `assertBootstrapConfigured` → `createApp`）でDB fileを開き、`@hono/node-server` で実portに起動する。違いは `GoogleOidcIdentityProvider` のtoken endpoint・JWKS・fetchをテスト用OIDC provider（`test/support/oidcFixture.ts`。Task 41のfixtureを共通化）へ注入することと、時刻を進められることだけで、ID Tokenの署名・issuer・audience・nonce・PKCE・client secretの検証は本番のadapterが行う。clientはCookie jarを持つfetchで、redirectを追わずにLocation・Set-Cookieを観測する。Humanの操作は `/auth/*`・`/api/*` だけで行い、DBはassertの観測にだけ読む。
- **空DBの通し検証**:
  - 未認証の `401`。未許可account・改ざんstate・nonce不一致でDB行が増えない。
  - 初期ownerの初回ログイン（Cookie属性 `__Host-`・`HttpOnly`・`Secure`・`SameSite=Lax`・`Path=/`・Domain無し、ログイン試行Cookieの削除）。`returnTo` のopen redirect（`//evil`・絶対URL・`/\evil`）は `/` になる。
  - CSRF（token無し・別Origin・Bearerだけ）の拒否と、Human向け `/api/*` のCORS非許可。
  - Project作成・招待。招待tokenだけ（email不一致）では受諾できず、招待User（editor / viewer）はログインでき、使用済み招待は再利用できない。
  - Role別操作: editorのIntent作成は成功、Project更新・招待は `403`、別Project・不在Projectは `404`、viewerの書込は `403`（`requiredRole`）、最後のownerの取消は `409 LAST_OWNER`。
  - 招待の取消・期限切れ（`invitation_expired`）・再発行後の古いtokenの拒否・同じ宛先への並行発行（`201` と `409 INVITATION_PENDING`）。Membership取消は次のrequestから反映される。
  - Session fixation: login前に仕込まれたCookieを使わない。他人の有効Sessionを仕込まれたブラウザでログインすると、仕込まれたSessionは失効する。logoutはCSRF必須。アイドル期限切れは `401`。
  - server再起動後もSession・失効状態・招待状態が保持される。
  - `/mcp`: 匿名の `tools/list` は `get_role_instructions` だけ。Human相当tool（`create_project`・`update_project`・`create_intent`・`list_projects`・`get_project`）は拒否、Agent名だけのBearerは `401`、Session Cookieは読まない。
- **秘密の非露出**: 上記の実行中のrequest log（console）とDB file（WALを含む）に、Session secret・CSRF token・招待token・code・state・nonce・Google access token・ID Token・client secretが無いこと、応答（本文・Location）にGoogle由来のtokenとclient secretが無いことを確認した。Session secretはSet-Cookie、招待tokenは発行応答の `invitationUrl` でだけ返す。
- **既存DB**: Actor無しのuse case（認証導入前・旧MCP `create_project` 相当）で作ったProject・Intent・Grant・archived Projectを持つDBでserverを起動する。初期ownerの初回ログインで両Projectのowner Membershipが付与され、owner不在のProjectが残らず、既存データを参照できることを確認した。
- **起動コマンド**: `src/server.ts` を子processで起動した。remoteのclient secret欠落・初期owner未設定・`NODE_ENV=production` のtrusted-localは終了コード1と `Configuration error: <環境変数名>` になり、値を出力しない。trusted-localでは開発用ログイン→Project作成→logoutがHTTPで通り、stdout / stderrへSession secret・CSRF tokenを出さない。
- **loopback禁止環境**: sandbox等でloopbackへのlistenが `EPERM` / `EACCES` になる環境では、実portを使うケースだけを理由付きでskipする。起動コマンドの設定エラー検証はlisten前に終了するため固定の `PORT` を使い、skipしない。
- **運用文書**: READMEに「Human 認証の設定と運用」（Google Cloudの設定、redirect URI、remote起動例とTLS終端、closed registration・初期owner・招待、secret管理、ローカルでの確認方法）を追加し、`.env.example` の説明を補った。
- **未検証**: 実Googleとの接続（実際のtoken endpoint・JWKS・同意画面、公開ステータス「テスト」時の挙動）、実際のHTTPS reverse proxy経由でのCookie・Origin転送、ブラウザでの `__Host-` Cookieの扱い（Set-Cookieの属性だけを確認）。ownerがGoogle accountを失った場合の復旧手段は対象外のまま。

## 選択理由と将来変更できる箇所

| 選択 | 理由 | 将来変更できる箇所 |
| --- | --- | --- |
| Human Roleを4段の順序付き集合にする | 権限表が「最低Role」だけで書け、検査が1関数で済む | 操作単位の細かい権限が要る時にdomainの権限表を集合型へ変える |
| 未所属・不在Projectを `404` にする | Project IDの存在を漏らさない（Story要件） | Agent側（`403`）と揃える必要が出たら、応答変換だけを変える |
| platform ownerに全Projectへの特権を持たせない | 権限経路をMembershipの1本に保ち、超越権限の監査・保護を不要にする | 運用上必要になったらplatform administratorを別概念で追加する |
| orphan Projectをplatform ownerへ補完 | 既存Projectを失わず、管理不能Projectを残さない。移行専用の手作業が不要 | MCPからのProject作成を塞いだ後は、補完を移行時の一回だけに縮小できる |
| 招待はリンク手渡し（メール送信なし） | メール配送基盤・送信secretを増やさない | 配送adapterを追加し、発行use caseから呼ぶ |
| 招待tokenをURL fragmentで渡す | access log・Refererへtokenを残さない | 変更不要 |
| Session・招待・login attemptのsecretはSHA-256のみ保存 | 256bit乱数のため低速hashは不要。DB漏洩時も再利用できない | secretの長さを変える場合もhash方式は維持 |
| CSRF tokenをsession secretのHMACで導出 | 保存が不要で、Sessionごとに固定・失効と連動する | 保存型のtokenへ変える場合もheader名は維持 |
| Session絶対7日・アイドル24時間・延長なし | 個人開発段階で再ログイン負担と漏洩時の影響を両立する | 値は定数1箇所。設定化は必要時に行う |
| `trusted-local` だけでLocalDevIdentityProvider | Google clientが無い開発環境でもWeb UIを使える。kitの「dev認証は明示フラグのみ、productionでは起動拒否」に合う | 不要になれば削除（Googleのlocalhost redirectで代替可能） |
| remoteでは`create_project` / `update_project` / Intent Commandを`/mcp`に登録しない | Human向け管理操作をMCPへ無条件に公開しない（`AGENTS.md`）。Agent用の認可Roleを新設するより単純で、Web APIの認可を迂回されない | Agentに必要になったら、専用Roleを定めて登録し直す |
| archived Projectの招待・Membership書込を全拒否し、archive前の`pending`招待も受諾させない | Step 5の「archivedは参照専用・例外なし」に合わせる。archive時に招待を連動取消しないのは、子データを変更しない既存規則と同じ | archived後のアクセス剥奪が必要なら、Membership取消だけを許可する例外を追加する |
| 期限切れの`pending`招待は再発行時に`revoked`にする | 部分unique indexを保ったまま再発行でき、期限切れ招待の受諾・取消は引き続き不可 | 期限切れを専用状態にする場合は、index条件と受諾条件を合わせて変える |
| 登録modeは `closed` のみ | 公開signupは対象外（Story） | `invite_only` 以外のmodeを追加する時に判定表へ分岐を足す |
| 退出・Human無効化のUIを作らない | 完了条件に無く、ownerによる取消で代替できる | use caseを追加してUIを足す |

## 対象外

Organization / Team、Google以外のProvider（adapter境界だけ保つ）、Passkey・多要素認証の自前実装、公開signup、課金、招待メールの送信、Human無効化・退出のUI、Human操作のactor監査ログ（Membership・招待の作成者 / 取消者以外）。Agent / Runtime Credentialは当初対象外としていたが、Task 37で実装した（下記「実装記録（Task 37）」）。

## 実装記録（Task 37: Agent・Runtime Credential）

- **形式**: `cmp_<agent|runtime>.<credentialId>.<secret>`。secretは256bit乱数（base64url）。保存は `access_credential`（id、project_id、kind、principal_id、scopes_json、prefix、secret_hash（SHA-256）、expires_at、revoked_at / revoked_by、last_used_at（60秒単位で更新）、created_at / created_by、rotated_from_id）。tokenは発行・rotationの応答（`no-store`）で一度だけ返す。
- **認証**: `resolveCaller`（presentation）が `cmp_` で始まるBearerを `AuthenticateAccessCredentialUseCase` で検証する。未知ID・hash不一致・種別違い・期限切れ・取消済みは理由を区別せず `UNAUTHENTICATED`。remote modeでは `cmp_` 以外のBearerを `UNAUTHENTICATED`（trusted-localへ降格しない）。trusted-localは従来のAgent名も受け付けるが、`cmp_` 形式はCredentialとして検証する。Session Cookieは `/mcp`・Runtime向けAPIで読まない。
- **呼出し主体**: application層の `Caller` = trusted-localのAgent名（string）| Agent Credential | Runtime Credential | null。Agent向けtoolは `agentPrincipalOf` でPrincipalを得てRole Grantで認可し（Runtime CredentialはPrincipalなし → `UNAUTHENTICATED`）、Runtime向けの入口は `RuntimeAuthorizationService.requireScope` で発行Project・scopeを検査する（Agent Credential・別Project・scope不足は `FORBIDDEN`、trusted-localのAgent名だけ暫定 `runtime` Grant）。
- **scope（初期選択）**: `runtime:event:read`、`runtime:event:ack`、`execution:change:read`（`list_changes`）、`execution:evidence:write`、`execution:summary:read`。Runtimeが現在使う入口に1対1で対応させた。
- **Project束縛（初期選択）**: Grantの多くのcheckがProject IDとPrincipal IDで行われ（Execution含む）、Credentialの発行Projectをすべての検査へ渡すと変更範囲が大きいため、「Agent Credentialを持つPrincipalは、そのProjectでしかGrant・有効なAgent Credentialを持てない」不変条件をrepositoryの同一transactionで保つ（Credential発行時に別ProjectのGrant・Credentialがあれば、Grant発行時に別Projectの有効なAgent Credentialがあれば `409 PRINCIPAL_BOUND_ELSEWHERE`）。別ProjectのAdministratorが同名PrincipalのCredentialを発行して他Projectの権限を得ることを防ぐ。Runtime CredentialはGrantを使わず発行Projectで検査するため束縛しない。
- **rotation**: 同じkind・Principal・scopesの新Credentialを発行し、旧Credentialの期限を `now + graceHours`（既定24、0〜168）まで縮める（延ばさない）。取消済み・期限切れはrotationできない（`409 CREDENTIAL_NOT_ACTIVE`）。
- **Web UI**: Project詳細の「Agent・Runtime Credential」（Administrator以上だけ表示）。一覧・発行・rotation（併用期間を選択）・取消、tokenは発行直後だけ表示。Runtime Grant sectionは削除した（`runtime` Grantは trusted-local の開発用としてWeb API / CLIに残す）。archivedでは一覧と取消だけ。
- **MCP（remote）**: 適用表どおり、`list_projects` はGrantの有るProjectだけ、Direction参照toolはいずれかのGrantを要求。Human管理・入力Commandの非登録と匿名時の `get_role_instructions` だけの公開はTask 42のまま。
- **CORS**: Bearerで呼ぶ `/mcp`・Runtime向けAPIは `origin: "*"` を維持した。CookieではなくBearerで認証するため、他originのページからHuman Sessionを使った呼出しにならない。
- **検証**: `test/accessCredential.test.ts`（発行・一覧のRole、secretのDB非保存、Agent / Runtimeの認可経路、期限切れ・取消・改ざん・未知ID・種別違い、rotation併用、remoteのAgent名拒否とtrusted-local、Project束縛、archived、再起動後の保持）、`test/credentialUi.test.ts`、`test/remoteMcpHumanCommands.test.ts`（remoteのBearerをAgent Credentialへ移行）。
- **未接続・未検証**: 実Runtime・Agentからの利用、実HTTP server上での統合検証（Task 38・44）。ログへのtoken非出力は、request logがpathだけでAuthorizationを記録しないことと、エラー応答にtokenを含めないテストで確認した（log出力そのものの捕捉テストは無い）。
