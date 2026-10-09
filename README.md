# Compass

Projectの方向と実行を管理するアプリケーションです。HumanはWeb UI、AgentはMCPから操作します。

## ドキュメント

- [文書一覧](docs/README.md)
- [確定した統合アーキテクチャ](compass-codex-architecture-handoff.md)
- [現在の実装状況](docs/implementation-status.md)
- [Wacha向け移行計画](docs/architecture-migration-plan.md)
- [Orchestrator](orchestrator/README.md)
- [Ralph](ralph/README.md)

以下は現在の実装の利用方法です。npm workspacesの`server/`がWeb UI・API・MCPを提供し、`packages/organization`・`packages/direction`・`packages/work`・`packages/access`・`packages/activity`・`packages/shared`の業務コードを配線します（`packages/organization`はWorkspace・Projectを所有します。Workspaceの公開入口はHuman向けWeb APIの参照だけで、Mission等はProjectの入出力で所属Workspaceの値を読み書きします）。`orchestrator/`はProject横断の現在状態から専門RoleのAgentを起動する独立したBatchで、ServerとはMCPだけで接続します。`ralph/`はWorker / ReviewerのAgentを1 Taskずつ起動する独立したLoopで、同じくMCPだけで接続します。`manager`の名前は維持します。実装変更はWacha経由で行います。

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

設定項目は [.env.example](.env.example) を参照してください。起動ディレクトリに`.env`があればserverが読み込みます。`.env.example`自体は読み込みません。`PORT`は`.env`読込前に確定するため、シェルの環境変数として渡してください。既定portは51800、`COMPASS_DB_PATH`はSQLiteの保存先、`COMPASS_CLAIM_TTL_MS`はClaim有効期間（既定30分）です。DBが無い場合は起動時に現在の定義からschemaを作成します。

リリース前の開発DBはschema変更時に破棄・再作成できます。Activityの3 scope対応、Intent/OutcomeのWorkspace所有列、Credentialの明示scope（`access_credential.scope_kind`）は新規DBのschemaを対象とし、旧tableへの列追加・履歴変換は行いません。DBを開いているCompassプロセスを停止してから、`COMPASS_DB_PATH`が指すDB fileを削除し、serverを起動してください。データ・ログイン情報・Credential・cursorは引き継ぎません。旧DBの非破壊migrationや旧クライアント互換は開発の必須条件にしません。

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

Project詳細でAgent名にManager・Worker・ReviewerのRole Grantを付け、同じAgent名のAgent Credentialを発行します。発行直後に一度だけ表示されるtokenをMCP clientへ渡します。

```bash
export COMPASS_AGENT_TOKEN="cmp_agent.<id>.<secret>"
```

MCP endpointは`http://localhost:51800/mcp`、認証headerは`Authorization: Bearer <token>`です。`COMPASS_AGENT_TOKEN`はclient側の環境変数で、serverは読みません。tokenを設定ファイルへ直書きせず、clientが環境変数から読み込むよう設定してください。

現在のRoleは`strategist` / `researcher` / `manager` / `worker` / `reviewer` / `evaluator`。`get_role_instructions({ role, includeShared: true })`でInstructionを取得できます。Grant発行だけではAgentは起動しません。新規Project GrantはManager・Worker・Reviewerと、trusted-localのOrchestrator用`runtime`（CLI・Web API）だけを許可し、Direction Roleは400 `VALIDATION_ERROR`で拒否します。DirectionのWorkspace Grantは内部applicationまで実装済みで、付与・取消の管理UI・公開入口は未接続です。Workspace CredentialはWeb API（`/api/workspaces/:workspaceId/credentials`）で発行でき、Direction toolはWorkspace Grantを持つWorkspace Agent Credentialで認可します。Workspace Grantを付与する公開入口が無いため、新規DBでのAgent Direction運転はGrant管理入口の接続（S10-03）後に利用できます。保存済みの旧Project Direction Grantは参照・取消できますが、WorkのTask・Story・Comment・Change Log参照には使えません。

Intent/Outcome/Research/Decision/Evaluation/Runtime eventの保存と応答はWorkspace所有（`workspaceId`）です。Direction（Intent/Outcome/Research/Decision/ADR/Evaluation/Runtime event）のWeb APIは`/api/workspaces/:workspaceId/…`、MCP toolは`workspaceId`を受け取り、Workspace Membership（Human）・Workspace Role Grant（Agent）・Workspace Runtime Credential（Runtime event）で認可します。Project配下の旧経路と`projectId`入力は無く、Project IDをWorkspace IDとして渡すことはできません。Project画面はProjectの所属Workspaceを解決してDirectionを表示します。ADR依頼/参照もWorkspace所有で、対象artifactのProject/Repository参照を保持します。Execution Summary/Evidenceは`workspaceId`と発生元`projectId`を返し、Outcome・Projectごとに還流状態を保持します。Runtime eventはversion 2で`workspaceId`を返し、`projectId`は持ちません。配送結果にも`workspaceId`を含めます。Outcomeの評価は全Target ProjectのSummary・Evidenceから行い、全Targetが還流し`incomplete`が無い場合だけ評価可能です。Workspace Role Grantの付与UI・OrchestratorのWorkspace dispatchは後続Taskです。旧Project scopeのDirection schemaは変換せず、開発DBを再作成して起動します。テストは`COMPASS_DB_PATH=:memory: npm test`でローカルDBから隔離できます。

Role・Skill・Knowledge・Policyはrepo直下の`roles/`・`skills/`・`knowledge/`・`policies/`にGit管理し、MCPから必要時に取得します。起動時はProject Role（manager / worker / reviewer）が`get_role_context({ projectId, role })`（ProjectのそのRoleのGrantが必要）でRole Definition・共通Policy・Roleがfrontmatterの`skills`で参照するSkillのmetadata・Project情報・所属Workspaceの要約（Mission / Vision / Principles / Constraints）・そのProjectがTargetのactiveなOutcome（Success Criteriaと関連Storyの`correlationId`）を、Workspace Role（strategist / researcher / evaluator）が`get_workspace_role_context({ workspaceId, role })`（WorkspaceのそのRoleのGrantが必要）で同じRole資産とWorkspaceのMission / Vision / Principles / Constraints・activeなProjectの要約（purposeとRepository / Resourceの参照。Story / Taskは含まない）を取得し、作業に入るときに`get_skill_context({ name })`でSkill本文とrequiredKnowledgeを取得します。`list_skills`はmetadataの一覧です。応答の`source.revision`は資産を読んだGit commit、`source.dirty`は未commit変更の有無です。Skillは認可を担わず、Roleとの対応はRole Definitionの`skills`だけで表します。Role Contextの`activity`は最近のActivityのsummaryとrefs（本文なし）で、Project向けはProject Activity、Workspace向けはWorkspace Activityだけです。

Activityは後から経緯を辿るための履歴です。Agentは`record_activity`で調査結果・判断理由・引き継ぎ等を記録し（`summary`必須、`body`は任意のMarkdown、`refs`で成果物の所在を参照）、`list_activities` / `get_activity`で参照します。いずれもProjectのGrantが必要です。応答には所属`workspaceId`が含まれます。Workspace Role（strategist / researcher / evaluator）はWorkspaceの調査・判断の経緯を`record_workspace_activity`で記録し、`list_workspace_activities` / `get_workspace_activity`で参照します（WorkspaceのRole Grantが必要。`refs`の`project_resource`は所属ProjectのRepository / Resource）。Story・Taskの重要な状態変更（起票・完了・レビュー・受入・差戻し・取消）、Directionの重要な状態変更（Intentの作成・放棄、Outcomeの確定・取消、Researchの依頼・終了、Direction Decision・Outcome Evaluationの記録）、Projectのarchiveはserverが同じtransactionで自動的に記録します。Work・Project archive・明示記録はProject Activity、Directionの自動記録はWorkspace Activityです。Humanは「Activity」sectionでProject Activityを確認できます。Workspace ActivityはWorkspace MembershipでWeb API（`GET /api/workspaces/:workspaceId/activities`）から読めます。Workspace ActivityはWorkspace Role Contextにも最近のsummaryとして含まれます。Workspace ActivityのWeb UIは未実装です。Activityはworkflow checkpointではなく、Change Log（`list_changes`）とも別です。

1回の実行で使うRoleは`X-Compass-Active-Role: <role>` headerで固定できます（MCP・Runtime向けAPI）。指定時はそのRoleのGrantだけで認可し、同じAgent名の他Grantは合算しません。trusted-local modeでも、指定時はProject参照・一覧（`get_project`・`list_projects`等）がそのRoleのGrantを持つProjectに限られます。Agent名（Bearer）なしでの指定はProject scopeのtool（Project参照・`update_project`・Intent管理・Work操作等）で`UNAUTHENTICATED`です。ただしtrusted-localの`create_project`はProject作成前の操作でGrantの対象外のため、activeRoleの指定に関係なく実行できます。Grantの無いRole・別Roleのtoolは`FORBIDDEN`、未知の値は400です。同じ`requestId`を別のactiveRoleで再送すると`IDEMPOTENCY_CONFLICT`になります。headerなしは従来どおり操作ごとに必要Roleを検査します。Worker / Reviewerは別Agent名・別Credentialで接続し、Role切替で自己レビュー・自己受入禁止を回避できません。

remote modeでは有効なCredentialが必要で、Project / IntentのHuman用変更toolは公開しません。trusted-localでは開発用にAgent名そのもののBearerも使用できます。

## Runtimeの接続

RuntimeにはAgentとは別のCredentialとscopeを発行します。Credentialは発行したWorkspaceまたはProjectだけで使え、互いに転用できません。現在の接続面はProject scopeで、Project Runtime Credentialを使います。

| 用途 | MCP |
| --- | --- |
| event取得・ack | `fetch_runtime_events` / `ack_runtime_event` |
| Executionの変更取得 | `list_changes` |
| Evidence還流・結果参照 | `record_execution_evidence` / `get_outcome_execution_summary` |
| Orchestrator向けの現在状態 | `get_orchestration_state`（Project Runtime Credential、scope `runtime:state:read`）/ `get_workspace_orchestration_state`（Workspace Runtime Credential、scope `runtime:state:read`） |

eventの`nextCursor`はページ送り専用で、再開位置には使いません。再開は`resumeCursor`または0から行います。配送はat-least-onceで、ack再送には同じ`attemptId`を使います。Task受入をOutcome達成として扱わず、Evidenceを評価へ渡します。

Orchestrator（[orchestrator/README.md](orchestrator/README.md)）は`get_orchestration_state`の現在状態から起動を判断し（Workspace単位の`get_workspace_orchestration_state`への切替はS08-02/03で未接続）、Activity cursorやRuntime eventのcursorをworkflow checkpointにしません。Intent作成時にResearch Requestは自動で作られず、OrchestratorがStrategistを起動してResearchの要否を判断させます。実Agentを起動した運用・Lv6自律運転は未検証です。

## 検証

```bash
COMPASS_DB_PATH=:memory: npm test
npm run typecheck
npm run lint
npm run build
```

rootの`test`・`typecheck`・`lint`は各workspaceへ、`build`は`server` workspaceへ委譲します。テストは`server/tests/`（結合・API・MCP・Web UI・認証）、`packages/work/tests/`（Workの規則）、`packages/organization/tests/`（Workspace・Project）、`packages/activity/tests/`（Activity）、`orchestrator/tests/`（起動判断・重複抑止、ServerとのプロセスをまたぐOrchestratorの結合）、`ralph/tests/`（ServerとのプロセスをまたぐRalphの結合）にあり、cwdは各workspaceです。`orchestrator`の`build`は型検査、`ralph`の`build`はshell scriptの構文検査で、`npm run build --workspace orchestrator` / `ralph`で独立して実行します。`lint`は現在、TypeScriptの型チェックです。実HTTPの認証テストはテスト用OIDC providerを使い、実Googleへの接続検証ではありません。fixtureによる閉ループ検証と実Agentの自律運転を区別します。
