# Step 6: Human認証・Project Membership・招待制 設計

> **状態: 設計（確定、Task 39）。永続化（domain・repository・schema・application use case）はTask 40で実装済みだが、Web API・MCP・画面には未接続。** Google OIDC・SessionはTask 41、Web APIへの認可適用はTask 42、UIはTask 43、実HTTP統合検証と運用文書はTask 44で行う。
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
- **拒否応答**: `/login?error=<code>` へ302し、画面は簡潔な文言だけを出す。`code` は `not_allowed`（未許可account・email未検証・email不一致・無効/使用済み/取消済み招待をまとめる）、`invitation_expired`（期限切れ招待。リンク保持者に再発行依頼を促すため区別）、`oidc_failed`（Google側エラー・state / nonce不一致・token検証失敗・期限切れログイン試行）の3種。Project名・招待先email・Human有無は出さない。

### platform owner と orphan Project

- platform ownerは「最初にbootstrapされたHuman」を示す属性で、**Project Membershipを迂回する特権は持たない**（全Projectの閲覧・変更権は無い）。
- **orphan Project**: 有効なowner Membershipを持たないProject（移行前から存在するProject、または認証導入前後にMCP `create_project` で作られたProject）。bootstrap時と、platform ownerの各ログイン時に、orphan Projectへplatform ownerのowner Membershipを同一transactionで冪等に補完する。これで既存Project / Intent / Outcome / Grantを失わず、管理不能Projectを残さない。
- remote modeでは、MCPからProjectを作る経路をTask 37で塞ぐ（下記「MCPの認証・認可適用表」）。塞いだ後も、補完は安全網として残す。

## Web Session・Cookie・CSRF・OIDCの契約

### 設定

| 環境変数 | 必須 | 規則 |
| --- | --- | --- |
| `COMPASS_AUTH_MODE` | 任意（既定 `remote`） | `remote` / `trusted-local`。Task 37のAgent Credentialと同じ値を共有する |
| `COMPASS_PUBLIC_ORIGIN` | remoteで必須 | 例 `https://compass.example.com`。remoteでは `https:` 以外を起動拒否。redirect URIは `${COMPASS_PUBLIC_ORIGIN}/auth/google/callback` に固定し、requestのHostから組み立てない |
| `COMPASS_GOOGLE_CLIENT_ID` / `COMPASS_GOOGLE_CLIENT_SECRET` | remoteで必須 | secretはログ・エラーへ出さない |
| `COMPASS_INITIAL_OWNER_EMAIL` | platform owner未作成なら必須 | 作成後は不要（読まない） |
| `COMPASS_REGISTRATION_MODE` | 任意（既定 `closed`） | `closed` 以外は起動拒否 |

- remoteで必須値の欠落・不正があれば起動時にfail-fastする（エラーにsecret値を含めない）。
- `trusted-local` はloopback（`127.0.0.1` / `::1` / `localhost`）にbindする場合だけ起動を許す。この場合に限り `LocalDevIdentityProvider`（`POST /auth/local/login`、emailだけで `provider = local`・`issuer = urn:compass:local` のIdentityとして扱う）を有効にする。registrationの規則（初期owner・招待）はGoogleと同じで、Googleの `(provider, issuer, subject)` とは混ざらない。remoteではrouteを登録しない。

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
- **ID Token検証**（Task 41）: GoogleのJWKSで署名（RS256）、`iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}、`aud` = client ID、`exp` > now（許容skew 60秒）、`iat` が未来でない、`nonce` = attemptのnonce、`email_verified = true`。JWKSは `Cache-Control` に従いcacheし、未知 `kid` で1回だけ再取得する。検証ライブラリの採用（例 `jose`）はTask 41で依存追加として判断する。
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
| Project参照 | Intent一覧・詳細、Outcome一覧・詳細、Research Request一覧・詳細、Direction Decision一覧、ADR参照一覧、Execution Summary | viewer | 既存のGET全般 |
| Project参照 | Agent Grant一覧 `GET .../grants` | viewer | secretを含まない |
| Project参照 | Membership一覧 `GET .../members` | viewer | 他Memberのemailを含む（同じProjectの協力者として必要） |
| Project参照 | Execution閲覧（U2: Story / Task / Change / Comment） | viewer | Task 42以降に追加されるrouteにも同じ規則 |
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
- **実装の担当**: MCPの認証・tool登録の切替・参照系のGrant検査は**Task 37**（Credentialとremote modeを実装するTaskのため）。Web API側の認可はTask 42。Task 42は、Web APIで塞いだ各Commandに対応するMCP toolが、remote modeで登録されていないか匿名で拒否されることを回帰テストで確認する。Task 44は、実HTTP serverで`/mcp`へ匿名で`tools/list`と各Human相当toolを呼び、拒否されることを確認する。

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
| 期限切れの`pending`招待は再発行時に`revoked`にする | 部分unique indexを保ったまま再発行でき、期限切れ招待の受諾・取消は引き続き不可 | 期限切れを専用状態にする場合は、index条件と受諾条件を合わせて変える |
| 登録modeは `closed` のみ | 公開signupは対象外（Story） | `invite_only` 以外のmodeを追加する時に判定表へ分岐を足す |
| 退出・Human無効化のUIを作らない | 完了条件に無く、ownerによる取消で代替できる | use caseを追加してUIを足す |

## 対象外

Organization / Team、Google以外のProvider（adapter境界だけ保つ）、Passkey・多要素認証の自前実装、公開signup、課金、招待メールの送信、Human無効化・退出のUI、Human操作のactor監査ログ（Membership・招待の作成者 / 取消者以外）、Agent / Runtime Credential（Task 37）。
