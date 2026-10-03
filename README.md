# Compass

Projectの方向と実行を管理するアプリケーションです。HumanはWeb UI、AgentはMCPから操作します。

## ドキュメント

- [文書一覧](docs/README.md)
- [確定した統合アーキテクチャ](compass-codex-architecture-handoff.md)
- [現在の実装状況](docs/implementation-status.md)
- [Wacha向け移行計画](docs/architecture-migration-plan.md)

以下は現在の実装の利用方法です。npm workspacesの`server/`がWeb UI・API・MCPを提供し、`packages/direction`・`packages/work`・`packages/access`・`packages/activity`・`packages/shared`の業務コードを配線します。`orchestrator/`・`ralph/`への移行は未実施です。`manager`の名前は維持します。実装変更はWacha経由で行います。

## 起動

```bash
npm install
COMPASS_AUTH_MODE=trusted-local COMPASS_INITIAL_OWNER_EMAIL=you@example.com npm start
```

`npm start`はWeb UI（`server/src/web`）を`server/public/`へbuildしてから、repo rootをcwdとしてHono server（`server/src/main.ts`）を起動します。同じportで以下を提供します。

| 接続先 | URL |
| --- | --- |
| Web UI | http://localhost:51800/ |
| Web API | http://localhost:51800/api |
| MCP | http://localhost:51800/mcp |
| Health | http://localhost:51800/health |

ブラウザで`/login`を開き、初期ownerのemailでログインします。trusted-localはloopback限定の開発用で、emailの本人確認を行いません。`NODE_ENV=production`では起動を拒否します。

設定項目は [.env.example](.env.example) を参照してください。起動ディレクトリに`.env`があればserverが読み込みます。`.env.example`自体は読み込みません。`PORT`は`.env`読込前に確定するため、シェルの環境変数として渡してください。既定portは51800、`COMPASS_DB_PATH`はSQLiteの保存先、`COMPASS_CLAIM_TTL_MS`はClaim有効期間（既定30分）です。

portが使用中なら既存プロセスを停止せず、同じ認証設定に`PORT=52000`等を加えて起動します。開発用の`npm run dev`はserverとViteを起動します。Viteの画面を使う場合は、そのoriginを`COMPASS_PUBLIC_ORIGIN`へ指定してください。

## remote mode

既定の認証modeはremoteです。GoogleのOIDC clientを用意し、redirect URIに`${COMPASS_PUBLIC_ORIGIN}/auth/google/callback`を登録します。scopeは`openid`・`email`・`profile`を使用します。

```bash
COMPASS_AUTH_MODE=remote \
COMPASS_PUBLIC_ORIGIN=https://compass.example.com \
COMPASS_GOOGLE_CLIENT_ID=<client ID> \
COMPASS_GOOGLE_CLIENT_SECRET=<secret管理機構から渡す> \
COMPASS_INITIAL_OWNER_EMAIL=owner@example.com \
npm start
```

公開originはhttps必須で、TLSは前段のproxy等で終端します。proxyはOriginとCookieを転送してください。必須設定が欠けると起動を拒否します。

登録は招待制です。初期ownerがログインした後、Project詳細のMember欄からownerが招待を発行し、表示されたリンクを相手へ渡します。メール送信は行いません。相手は招待先emailのGoogleアカウントでログインします。platform ownerにProject Membershipを迂回する権限はありません。

Sessionは発行から7日または無操作24時間で失効します。secretはリポジトリへ保存しません。認証・権限・Cookie・CSRFの詳細は [認証仕様](docs/step-6-human-auth-design.md) を参照してください。

## Humanの操作

- Projectを作成し、Mission・Vision・Principles・Constraints・Repositories・Resourcesを登録する。
- Project内でIntentを作成し、Outcomeと固定成功条件を管理する。
- Research・Decision・Evidence・Evaluation・Executionを確認する。
- editor以上はStory / Taskの手動起票・編集、Taskの受入・差戻し・取消・Commentを行う。Outcome handoff管理下のStory / Taskは直接編集できない。編集は変更前後とともにChange Logへ残り、「最近の変更」で確認できる。
- administrator以上はProject情報、Agent Grant、Credentialを管理する。ownerはMember招待・権限変更とProject archiveを行う。

archived Projectは参照専用です。復帰・物理削除は提供していません。通常操作にCLIやDBの直接編集は使いません。

## Agentの接続

Project詳細でAgent名に必要なRole Grantを付け、同じAgent名のAgent Credentialを発行します。発行直後に一度だけ表示されるtokenをMCP clientへ渡します。

```bash
export COMPASS_AGENT_TOKEN="cmp_agent.<id>.<secret>"
```

MCP endpointは`http://localhost:51800/mcp`、認証headerは`Authorization: Bearer <token>`です。`COMPASS_AGENT_TOKEN`はclient側の環境変数で、serverは読みません。tokenを設定ファイルへ直書きせず、clientが環境変数から読み込むよう設定してください。

現在のRoleは`strategist` / `researcher` / `manager` / `worker` / `reviewer` / `evaluator`。`get_role_instructions({ role, includeShared: true })`でInstructionを取得できます。Grant発行だけではAgentは起動しません。

Role・Skill・Knowledge・Policyはrepo直下の`roles/`・`skills/`・`knowledge/`・`policies/`にGit管理し、MCPから必要時に取得します。起動時は`get_role_context({ projectId, role })`（そのRoleのGrantが必要）でRole Definition・共通Policy・Roleがfrontmatterの`skills`で参照するSkillのmetadata・Project情報を取得し、作業に入るときに`get_skill_context({ name })`でSkill本文とrequiredKnowledgeを取得します。`list_skills`はmetadataの一覧です。応答の`source.revision`は資産を読んだGit commit、`source.dirty`は未commit変更の有無です。Skillは認可を担わず、Roleとの対応はRole Definitionの`skills`だけで表します。Role Contextの`activity`は最近のActivityのsummaryとrefs（本文なし）です。

Activityは後から経緯を辿るための履歴です。Agentは`record_activity`で調査結果・判断理由・引き継ぎ等を記録し（`summary`必須、`body`は任意のMarkdown、`refs`で成果物の所在を参照）、`list_activities` / `get_activity`で参照します。いずれもProjectのGrantが必要です。Story・Taskの重要な状態変更（起票・完了・レビュー・受入・差戻し・取消）と、Directionの重要な状態変更（Intentの作成・放棄、Outcomeの確定・取消、Researchの依頼・終了、Direction Decision・Outcome Evaluationの記録、Projectのarchive）はserverが同じtransactionで自動的に記録します。Humanは「Activity」sectionでProject詳細から確認できます。Activityはworkflow checkpointではなく、Change Log（`list_changes`）とも別です。

1回の実行で使うRoleは`X-Compass-Active-Role: <role>` headerで固定できます（MCP・Runtime向けAPI）。指定時はそのRoleのGrantだけで認可し、同じAgent名の他Grantは合算しません。trusted-local modeでも、指定時はProject参照・一覧（`get_project`・`list_projects`等）がそのRoleのGrantを持つProjectに限られます。Agent名（Bearer）なしでの指定はProject scopeのtool（Project参照・`update_project`・Intent管理・Work操作等）で`UNAUTHENTICATED`です。ただしtrusted-localの`create_project`はProject作成前の操作でGrantの対象外のため、activeRoleの指定に関係なく実行できます。Grantの無いRole・別Roleのtoolは`FORBIDDEN`、未知の値は400です。同じ`requestId`を別のactiveRoleで再送すると`IDEMPOTENCY_CONFLICT`になります。headerなしは従来どおり操作ごとに必要Roleを検査します。Worker / Reviewerは別Agent名・別Credentialで接続し、Role切替で自己レビュー・自己受入禁止を回避できません。

remote modeでは有効なCredentialが必要で、Project / IntentのHuman用変更toolは公開しません。trusted-localでは開発用にAgent名そのもののBearerも使用できます。

## Runtimeの接続

RuntimeにはAgentとは別のCredentialとscopeを発行します。現在の接続面は以下です。

| 用途 | MCP |
| --- | --- |
| event取得・ack | `fetch_runtime_events` / `ack_runtime_event` |
| Executionの変更取得 | `list_changes` |
| Evidence還流・結果参照 | `record_execution_evidence` / `get_outcome_execution_summary` |

eventの`nextCursor`はページ送り専用で、再開位置には使いません。再開は`resumeCursor`または0から行います。配送はat-least-onceで、ack再送には同じ`attemptId`を使います。Task受入をOutcome達成として扱わず、Evidenceを評価へ渡します。

実RuntimeによるAgent起動・Lv6自律運転は未接続・未検証です。統合後のOrchestratorは現在状態から起動を判断し、Activity cursorをworkflow checkpointにしません。

## 検証

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

rootの`test`・`typecheck`・`lint`は各workspaceへ、`build`は`server` workspaceへ委譲します。テストは`server/tests/`（結合・API・MCP・Web UI・認証）、`packages/work/tests/`（Workの規則）、`packages/direction/tests/`（Project集約）にあり、cwdは各workspaceです。`lint`は現在、TypeScriptの型チェックです。実HTTPの認証テストはテスト用OIDC providerを使い、実Googleへの接続検証ではありません。fixtureによる閉ループ検証と実Agentの自律運転を区別します。
