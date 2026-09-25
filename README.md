# Compass

Direction を永続化・公開するためのアプリケーションです。

## 起動

```bash
npm install
npm start
```

`npm start` は Web UI を build してから Hono server を起動します。同じ port で次を提供します。

- Web UI: `http://localhost:51800/`
- Web API: `http://localhost:51800/api`
- MCP: `http://localhost:51800/mcp`
- health check: `http://localhost:51800/health`

既定 port は `51800` です（Wacha の既定 port `51743` とは衝突しないため、Wacha と同時に起動できます）。環境変数は [.env.example](.env.example) を参照してください。`PORT` で port、`COMPASS_DB_PATH` で Project を保存する SQLite file を指定します。`COMPASS_CLAIM_TTL_MS` は Execution の Task Claim の有効期間（ミリ秒、既定 30 分）です。

Human 認証の設定は必須です（既定の `COMPASS_AUTH_MODE` は `remote`）。必須値が欠けていると `Configuration error: <環境変数名> ...` を出して起動を拒否します（値・secret は出力しません）。ローカル開発では loopback だけに bind する `trusted-local` を明示し、初期 owner の email を渡します。

```bash
COMPASS_AUTH_MODE=trusted-local COMPASS_INITIAL_OWNER_EMAIL=you@example.com npm start
```

- `trusted-local`: `NODE_ENV=production` では起動を拒否します。`127.0.0.1` に bind し（`COMPASS_HOST` は loopback のみ可）、`POST /auth/local/login`（form の `email`）で Google なしにログインできます。登録規則は Google と同じで、初期 owner か有効な招待の宛先だけがログインできます。公開 origin の既定は `http://localhost:$PORT` で、ブラウザもこの origin で開きます（Vite dev server 経由で操作するときは `COMPASS_PUBLIC_ORIGIN` に Vite の origin を指定します）。
- `remote`: `COMPASS_PUBLIC_ORIGIN`（https の origin）、`COMPASS_GOOGLE_CLIENT_ID`、`COMPASS_GOOGLE_CLIENT_SECRET` が必須です。Google Cloud の OAuth client の承認済み redirect URI に `${COMPASS_PUBLIC_ORIGIN}/auth/google/callback` を登録します。
- platform owner（最初にログインした初期 owner）が未作成の間は `COMPASS_INITIAL_OWNER_EMAIL` が必須です。

`.env.example` は自動では読み込まれません。値を変えるときは `.env.example` をコピーして読み込むのではなく、シェルの環境変数として渡してください。

```bash
PORT=52000 npm start
```

`EADDRINUSE`（port が使用中）で起動に失敗した場合は、既存プロセスを停止せず、上記のように `PORT` で別の port を指定してください。開発時に Vite の proxy 先を変える場合も、同じ `PORT` を指定します。

開発時は server と Vite dev server を同時起動できます。

```bash
npm run dev
```

## 操作主体と入口

| 主体 | 正規の入口 | 備考 |
| --- | --- | --- |
| Human | Web UI | Project・Intent・Outcome・Role Grant など製品の通常操作は Web UI で行います。Human 向け機能を CLI・MCP・DB の直接操作だけで完結させません |
| Agent | MCP | Strategist などの Agent は MCP から操作します。Human 向けの管理操作（Grant の発行・取消、Project の archive など）は MCP へ公開しません |
| Web UI・外部 Runtime | Web API | Web API は Web UI と外部 Runtime の接続面です |
| 開発者・保守 | CLI | ローカル開発・移行・障害復旧・自動検証用です。Human の通常操作手順ではありません |

Web UI と MCP は同じ application 層へ委譲し、業務規則を入口ごとに重複させません。Cloudflare 等へのリモート配置を想定しているため、Human が server の filesystem や SQLite file へ直接アクセスすることを前提にしません（CLI が SQLite file を直接使うのはローカルの保守・自動検証に限ります）。

## MCP Registration

Compass MCP は Streamable HTTP の `http://localhost:51800/mcp` で接続します。Outcome を作成する
Strategistには `Authorization: Bearer <token>` が必要です。remote mode では Project 詳細の「Agent・Runtime Credential」で
Administrator 以上が発行した Agent Credential（`cmp_agent.<id>.<secret>`）だけを受け付けます（後述「Agent・Runtime Credential」）。
trusted-local mode では従来どおり Agent 名そのもの（`Bearer <AgentName>`）も使えます。Agent名・Credential の Agent 名は、
後述の Project Role Grant に登録する Agent 名と一致させてください。

```bash
export COMPASS_AGENT_NAME="strategist-agent"
```

`COMPASS_AGENT_NAME`はMCP clientが読む環境変数で、Compass serverは読みません。clientはこれを設定したシェルから起動してください。

### Codex

`~/.codex/config.toml`、または信頼済みProjectの `.codex/config.toml` に登録します。

```toml
[mcp_servers.compass]
url = "http://localhost:51800/mcp"
bearer_token_env_var = "COMPASS_AGENT_NAME"
```

CLIから登録する場合は次のコマンドを使います。

```bash
codex mcp add compass \
  --url http://localhost:51800/mcp \
  --bearer-token-env-var COMPASS_AGENT_NAME
```

`codex mcp list`で登録を確認し、Codexを再起動してください。TUIでは`/mcp`で接続状態を確認できます。

### Claude Code

Projectルートの `.mcp.json` に登録する場合は次のように記載します。

```json
{
  "mcpServers": {
    "compass": {
      "type": "http",
      "url": "http://localhost:51800/mcp",
      "headers": {
        "Authorization": "Bearer ${COMPASS_AGENT_NAME}"
      }
    }
  }
}
```

### StrategistとしてOutcomeを作成する

1. `npm start`でCompassを起動する。
2. Web UIでProjectとActive Intentを作成する。
3. Project詳細のStrategist欄で、`COMPASS_AGENT_NAME`と同じAgent名に`strategist`を付与する。
4. MCP clientを起動し、`get_role_instructions({ role: "strategist", includeShared: true })`を読む。
5. 対象の`projectId`が明示されていればそれを使う。明示されていなければInstructionに従い、`list_projects`と`get_strategist_context`でStrategistとして操作できる候補を確認する（1件なら自動選択、0件または複数件なら報告して停止）。
6. `get_strategist_context({ projectId })`でProject、Active Intent、既存Outcome、Active IntentのIntent Brief（`research`）を取得する。Synthesis→Finding→Evidence参照の詳細が要る場合は`get_research_request({ projectId, requestId })`で辿る。
7. 情報が十分なら`create_outcome`でOutcomeと成功条件を登録する。

例えば、接続したAgentへ次のように依頼できます。

```text
Compass MCPを使い、Project <projectId> のStrategist InstructionとContextを読んでください。
Intentを達成するための情報が十分なら、Outcomeと成功条件を作成してください。
不足している場合はOutcomeを作らず、必要な情報とResearchすべき問いを報告してください。
```

`get_role_instructions`はBearer・Grantを必要としません。`get_strategist_context`と`create_outcome`はBearerがないと`UNAUTHENTICATED`、そのProjectのStrategist Grantがないと`FORBIDDEN`になります。Agent名の不一致を疑うときは、Project詳細のStrategist欄で割当済みのAgent名を確認してください。

`create_outcome`の送信後にタイムアウト・切断などで保存成否が不明になった場合は、同じProjectのContextを再取得し、送信内容と全項目が一致するOutcomeが無いことを確認してから同一入力を1回だけ再送します。再送も結果不明なら再取得と照合だけを行い、それ以上は送信しません。現時点の`create_outcome`は`requestId`による冪等性を提供しておらず、この再取得手順は運用上の重複回避策です。

Research Request・Result・Finding・Evidence参照・Synthesisのdomain・永続化・application層は実装済み（Task 23）で、
Researcher Role・Instruction・MCP tool（`get_researcher_context`・`list_research_requests`・`register_research_result`・`register_research_synthesis`・`complete_research_request`）も実装済みです（Task 24）。
ResearcherのGrantはWeb API（`POST /api/projects/:projectId/grants`、`role: "researcher"`）またはProject詳細のWeb UI（Researcher section、Task 29で追加）から発行・取消でき、CLIでも同じapplication処理を使えます。Web APIのResearch参照入口（`GET /api/projects/:projectId/research-requests`・`GET /api/projects/:projectId/research-requests/:requestId`）もTask 29で実装済みです。Runtimeによる起動は引き続き未接続です。
`get_strategist_context`の`research`（Active IntentのIntent Brief: 関連Synthesis要約・Finding競合・鮮度・残予算）はTask 26で実装済みで、`unavailable`からは外れました（Task 36で`evaluation`も外れ、残るのは`evidence`）。Synthesis→Finding→Evidence参照の詳細は、`research.requests`のidを指定するMCP tool `get_research_request`で辿れます。

Direction Decision（Compassを正本とする判断記録）はTask 27で実装済みです。MCP tool `create_direction_decision`（`additional_research` / `intent_complete` / `intent_abandon` / `policy_proposal` / `adr_candidate`）と`decide_next_outcome`（`next_outcome`。Decision と Outcome を1 transactionで保存し、既存の`create_outcome`固定Success Criteriaはそのまま使う）が、Strategist Grantで判断・理由・選択肢・使用したSynthesis（id+version）/ Finding idと、判断時点のIntent Brief snapshotを保存します。`requestKey`で再送を冪等にし、同じkeyで異なる内容が来たら`CONFLICT`にします。`decide_next_outcome`で作成したOutcomeは`originDecisionId`でDecisionを参照でき、既存の`create_outcome`（Decisionを経由しない作成）はそのまま使え、そのOutcomeの`originDecisionId`は`null`のままです。`policy_proposal`はMission / Vision / Principles / Constraintsを直接変更せず、判断を記録するだけです。

`additional_research`はTask 32で、Strategistが決める調査計画`research`（`question` / `scope` / `completionCondition` / `budgetTotal` / 任意の未来の`deadlineAt`）を必須とし、Direction Decision・追加Research Request・`research_requested`イベントを1 transactionで保存します（相関IDは`decision:{decisionId}`）。同じ`requestKey`の再送は重複せず、異なる内容は`CONFLICT`、他のtypeでの`research`指定や不正な予算・過去の期限は`VALIDATION_ERROR`です。Runtimeは`fetch_runtime_events`で新しいイベントを取得できますが、Researcherの起動は未接続です。

`adr_candidate`のDirection Decisionから、既存Wacha Manager / Worker / Reviewerへ渡す依頼と完了結果の参照はTask 28で実装済みです。MCP tool `create_adr_handoff_request`が、`decisionId`（`adr_candidate`のDecision）と`repositoryId`（Projectに登録済みのRepository）からWachaへの依頼payloadをfixtureとして組み立てて保存します（`expectedAdrContent`はDecisionの`judgment` / `reason` / `options`から決定的に作られ、呼び出し側が別の自由記述を渡すことはありません）。`record_adr_reference`が、Wachaが完了させた結果（対象Repository内の相対path、完全な40桁のcommit SHA、任意のPR URL）を取り込みます。`path`はCompass serverのローカルfilesystem pathとして扱わず、絶対pathや`..`を含むpathは`VALIDATION_ERROR`で拒否します。`record_adr_reference`は、同じ`decisionId` / `repositoryId` / `correlationId`の`create_adr_handoff_request`が先に存在しない場合は`CONFLICT`で拒否し、依頼を経ていない参照を受け付けません。`list_adr_references`でProject scopeの参照を新しい順に確認できます。実WachaやGitHub APIとは未接続で、fixtureによる契約検証までです。Human向けのResearch・Direction Decision・ADR参照の読み取り専用画面（Web API: `GET /api/projects/:projectId/research-requests[/:requestId]`・`GET /api/projects/:projectId/intents/:intentId/decisions`・`GET /api/projects/:projectId/adr-references`、Web UI: Project詳細のResearch section・ADR参照section、Intent詳細のDirection Decision section）はTask 29で実装済みです。Repository ADRのHuman向け自動反映は引き続き対象外です。
現時点ではStrategistが情報不足を報告し、根拠を推測で補わないところまでをInstructionで定めています。

## Execution（Story・Task・Claim。Task 33・34）

旧 Wacha の Execution（Story / Task / Claim / Comment / Change Log、manager / worker / reviewer）を Compass に移植しました。別の Wacha server は起動せず、同じ Hono server・同じ port・同じ `/mcp`、同じ Project・同じ Role Grant を使います（設計は [docs/lv6-unification-design.md](docs/lv6-unification-design.md)）。

- **MCP tool**（旧 Wacha の名前・入出力を維持）: `list_stories` / `list_tasks` / `list_task_comments` / `list_changes` / `issue_story` / `edit_story` / `complete_story` / `cancel_story` / `issue_task` / `edit_task` / `cancel_task` / `claim_task` / `claim_review` / `claim_acceptance` / `renew_claim` / `release_claim` / `add_task_comment` / `complete_task` / `reviewed_task` / `accept_task` / `reject_task`。Direction の tool と同じ endpoint から列挙されます。旧 Wacha の `list_projects`（Grant 済み Project 一覧）・`list_skills`・`get_skill_context` は移植せず、Project は既存の `list_projects` / `get_project`、Instruction は既存の `get_role_instructions`（`manager` / `worker` / `reviewer`）を使います。
- **認可**: Agent Credential（trusted-local では `Authorization: Bearer <AgentName>` も可）から得る Principal と、Project の Role Grant で検査します。Bearer なしは `UNAUTHENTICATED`、Grant なしは `FORBIDDEN`。Execution の tool は旧 Wacha と同じ `{ error: { code, message, retryable } }` でエラーを返し、状態を変える tool は `requestId` で冪等です（同じ入力の再送は元の結果、別の入力での再利用は `IDEMPOTENCY_CONFLICT`）。排他 Claim、自己 review・自己受入の禁止、`reject` の意味は `agent/role-policy.md` にあります。
- **Outcome 起点の引き渡し**: Outcome が確定すると `outcome_confirmed` の Runtime event が保存されます。外部 Runtime が Manager を起動し、Manager が `issue_story({ projectId, title, outcomeId, repositoryId?, requestId })` を呼ぶと、Compass は Outcome の固定 Success Criteria・origin Decision・その時点の Project Constraints・対象 Repository を Story に snapshot として保存します。相関 ID の既定は `outcome:<outcomeId>` で、Project 内で一意です。同じ handoff の再送は、新しい `requestId` でも既存の Story を返し、二重に作りません（別内容なら `IDEMPOTENCY_CONFLICT`）。handoff Story 配下の `issue_task` は `taskKey`（Story 内で一意な論理 ID。Manager が計画から決定的に付ける）が必須で、同じ `taskKey` の再送は新しい `requestId` や server 再起動後の別 Manager からでも既存の Task を返します（title・description が違えば `IDEMPOTENCY_CONFLICT`）。手動起票の Task では `taskKey` は任意で、従来どおり `requestId` だけで冪等です。Outcome が Project に無い・Repository が無いときは `NOT_FOUND`、Outcome が取消済み・Project が archived のときは `CONFLICT`、入力不正は `INVALID_INPUT` で、Story は一部だけ作られません。Direction は Story・Task・Claim を、Execution は Outcome・Success Criteria を変更しません。
- **Execution → Direction の還流（Task 34）**: 外部 Runtime が `list_changes` で Change を増分取得したあと、MCP `record_execution_evidence({ projectId, outcomeId, changeCursor, evidence? })`（Web API: `POST /api/projects/:projectId/outcomes/:outcomeId/execution-evidence`）を呼ぶと、Outcome に相関付いた Story / Task の結果が Direction 側に保存されます。`list_changes` の Story・Task の変更には、Outcome に相関付く場合 `outcomeId` / `correlationId` が付きます。結果（`accepted` / `rejected` / `canceled` / `incomplete`、Story ごとの Task 件数）は Runtime の申告ではなく、Compass が Execution の現在の状態から読取専用ポート（`ExecutionSummaryPort`）で導出します。Runtime が渡すのは Evidence の参照（`kind` / http(s) の `uri`（認証情報付きは不可）/ 完全な 40 桁の `versionHash`（`commit` は必須）/ 未来でない `observedAt`）と、読んだところまでの `changeCursor` だけで、Evidence 本文は保存しません。保存先は Direction 所有の `outcome_execution_summary`（Outcome ごとに 1 行）と `outcome_execution_evidence`（Outcome・種別・URI・version で一意、1 Outcome 200 件まで）で、Execution の table は読みません。同じ通知の再送は重複せず、古い `changeCursor` の通知（順序逆転）は状態を巻き戻さず現在の状態で回復し（`recorded.staleInput`）、server / Runtime の再起動後も同じ最終状態に収束します。Execution 未着手の Outcome・取消済み Outcome・archived Project は `CONFLICT`、別 Project・存在しない Outcome は `NOT_FOUND`、不正な URI / SHA / 時刻・Change Log より先の `changeCursor` は `VALIDATION_ERROR` です。還流済みの結果は MCP `get_outcome_execution_summary`（Runtime Credential の `execution:summary:read` scope が必要）と Human 向けの Web API `GET /api/projects/:projectId/outcomes/:outcomeId/execution-summary` で読めます。`accepted` は Success Criterion の充足を意味せず、Outcome も変更しません（判定は Evaluation の責務。Task 35 で保存まで実装、後続の遷移は Task 36）。
- **Outcome Evaluation（Task 35）**: `evaluator` Grant を持つ Agent が MCP `get_evaluator_context({ projectId, outcomeId })`（Project・Intent・固定の Success Criteria を含む Outcome・還流済みの Execution Summary と Evidence 参照（各 `id` 付き）・過去の Evaluation。Evidence 本文は含まず `unavailable: ["evidence_content"]`）で入力を取得し、`record_outcome_evaluation({ projectId, outcomeId, requestKey, runRef, criteria: [{ criterionId, verdict, rationale, evidenceIds }] })` で保存します。Success Criterion をすべて 1 回ずつ判定し、`verdict` は `met` / `not_met` / `insufficient_evidence`。`met` / `not_met` はこの Outcome に還流済みの Evidence 参照を 1 件以上持たなければ `VALIDATION_ERROR` で、観測できないものは `insufficient_evidence` で残します（成功・失敗を推測しません）。総合結果は指定させず、Criterion の判定から導出します（すべて `met` だけが `achieved`、1 つでも `not_met` があれば `failed`、それ以外は `insufficient_evidence`）。Execution が `accepted` でも `achieved` にはなりません。保存先は Direction 所有の `outcome_evaluation`（追記のみ。Criterion ごとの判定・根拠・Evidence 参照 id、`principalId`（Bearer）・`runRef`・`requestKey`、評価時の Outcome・Execution Summary・Evidence 参照の snapshot）で、Outcome・Success Criteria・Execution は変更せず、Outcome の状態も変えません。同じ `requestKey` の再送は同じ Evaluation を返し（`recorded: false`）、内容が違えば `CONFLICT` です。Execution が未還流（`reason: no_execution_summary`）・`active` でない Outcome・archived Project は `CONFLICT`、別 Project の Outcome は `NOT_FOUND`、`evaluator` 以外（strategist・researcher・manager・worker・reviewer・runtime・別 Project・取消済み Grant）は `FORBIDDEN`、Bearer なしは `UNAUTHENTICATED` です。`evaluator` の Grant を持つ Principal は `update_project` / `create_intent` / `update_intent` / `abandon_intent` も `FORBIDDEN` になります。保存と同じ transaction で `outcome_evaluated` の Runtime event を 1 件作ります（再送では作りません）。Intent が `active` でない Outcome は `CONFLICT`（`reason: intent_not_active`）です。手順は `get_role_instructions({ role: "evaluator" })`（`agent/evaluator.md`）にあります。
- **archived Project**: `issue_story` / `issue_task` / `claim_task` は `CONFLICT`（`projectStatus: "archived"`）で拒否します。参照は可能です。
- **Human の入口**: Manager・Worker・Reviewer の Grant は Project 詳細の Web UI から発行・取消できます（Evaluator・Runtime も同じ画面。Task 35 の差し戻し対応で追加）。Execution の Story・Task をHuman が閲覧・操作する Web UI / API は未実装です。

実装済み・未接続・未検証:

- **Evaluation からの再計画・Intent 完了（Task 36）**: 外部 Runtime は `outcome_evaluated`（`evaluationId` 付き）で Strategist を起動します。`get_strategist_context` は Active Intent 配下の各 Outcome の最新 Evaluation を `evaluations` で返し（`decisionId` が `null` のものが判断待ち）、`unavailable` から `evaluation` を外しました。Strategist は Direction Decision に `evaluationId` を付けて判断します: `failed` / `insufficient_evidence` なら `decide_next_outcome` または `additional_research`、`achieved` なら Intent の `completionDefinition` と照らして `intent_complete`（`evaluationId` 必須。achieved の Evaluation と完了定義が必要で、同じ transaction で Intent を `achieved` にします）か、次の Outcome です。1 つの Evaluation を根拠にできる Decision は 1 件だけ（Strategist の重複起動で再計画・完了を二重にしない）で、同じ Outcome の再評価で置き換えられた古い Evaluation・取消済み Outcome の Evaluation・active でない Intent・archived Project からは遷移しません（`CONFLICT`）。Outcome の状態（`achieved` 等は予約のまま）と Execution は変更せず、Execution の完了や単一 Outcome の達成だけで Intent を達成にしません。
- 実装済み: 上記の tool・認可・冪等性・Change Log・handoff、`outcome_confirmed`、Execution 用 table の追加（`initializeSchema` が既存 DB に冪等に追加）。旧 Wacha の `TaskCoordinationService` の回帰テスト（`test/executionCoordination.test.ts`）、統一 `/mcp` 経由のテスト（`test/executionMcp.test.ts`）、handoff（`test/executionHandoff.test.ts`）、Evidence 還流（`test/executionEvidence.test.ts`）、境界（`test/executionBoundary.test.ts`）、イベントとマイグレーション（`test/outcomeConfirmed.test.ts`）で確認しています。
- 未接続: 外部 Runtime による `outcome_confirmed` の取得・Manager の起動、Agent の自律起動。外部 Runtime による Evidence 還流の起動（`record_execution_evidence` はテスト内の呼び出しで確認）、Evaluator・Strategist の起動（どちらも自動起動されず、`record_outcome_evaluation` と Evaluation からの再計画・Intent 完了はテスト内の MCP 呼び出しで確認。`test/evaluationReplan.test.ts`）。Agent / Runtime 用の不透明 Credential は Task 37 で実装済み（実 Runtime からの利用は未接続）。
- 未検証: 上記のテストは Runtime を模したテスト内の MCP 呼び出しで、Lv6 の自律運転の実証ではありません。
- 移植しなかったもの: 旧 Wacha の Web UI（Project Activity・Task drawer 等）、trusted-local の operator 受入・差戻し、`list_projects` / Skill / Knowledge。

## 検証

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Step 1 の Project 仕様は [docs/step-1-project-design.md](docs/step-1-project-design.md) に記載しています。
Step 2 の Intent 仕様と実装状況・検証手順は [docs/step-2-intent-design.md](docs/step-2-intent-design.md) に記載しています。Intent は Project 配下に保存され、Web UI（Project 詳細の Intent section）、Web API（`/api/projects/:projectId/intents`）、MCP（`create_intent` / `list_intents` / `get_intent` / `update_intent` / `abandon_intent`）から作成・参照・更新・放棄できます。Strategist の Role Grant・Instruction・認可は Step 4 で実装済みですが（後述）、Runtime による Strategist の自動起動と Research は未実装です（Outcome は Step 3 で追加）。事前のユーザー確認は設けず、完成後のフィードバックに応じて修正します。

Step 3 の Outcome と成功条件の仕様と実装状況・検証手順は [docs/step-3-outcome-design.md](docs/step-3-outcome-design.md) に記載しています。Outcome は Intent 配下に成功条件（1〜10件、作成時に固定）とともに保存され、Web UI（Intent 詳細の Outcome section、Project 詳細の Active Outcomes）、Web API（`/api/projects/:projectId/intents/:intentId/outcomes`）、MCP（`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`。書込は Step 4 以降 Strategist Grant と Bearer が必要）から作成・参照・更新（title・hypothesis のみ）・取消できます。Intent から Outcome は自動生成されず、Evaluation・Strategist の自動起動は未実装です（Execution は Task 33 で統合済み。後述の「Execution」）。

Step 4 の Strategist Role と認可境界（Project 単位の Role Grant、`Authorization: Bearer <AgentName>` による MCP の Principal 解決、Grant の Command API・CLI、Instruction 配信）は [docs/step-4-strategist-role-design.md](docs/step-4-strategist-role-design.md) に設計を記載しています。

- **実装済み（Task 14）**: Strategist の Role Grant の永続化（SQLite `project_grant`）、Web API、CLI、Web UI（Project 詳細の Strategist section）。
- **実装済み（Task 15）**: MCP の Principal 解決と Strategist 認可。`Authorization: Bearer <AgentName>` の値をそのまま Principal とし（trusted-local。秘密の検証はなく、セキュリティ境界ではありません）、Grant で次を検査します。
  - `get_strategist_context`（Project・Active Intent・既存 Outcome を返す）と `create_outcome` / `update_outcome` / `cancel_outcome` は、その Project の Strategist Grant が必須です。Bearer なしは `UNAUTHENTICATED`、Grant 無し（別 Project・取消済み・存在しない Project を区別しない）は `FORBIDDEN` で、どちらも `isError: true` の tool 結果です。
  - その Project の Strategist Grant を持つ Principal は `update_project` / `create_intent` / `update_intent` / `abandon_intent` を `FORBIDDEN` で拒否されます（職務分離。Bearer なし・Grant なしは従来どおり成功）。
  - `Authorization` が有るのに形式不正（`Basic ...`、値なし、101 文字以上、制御文字）の `/mcp` は HTTP `401`（JSON-RPC `-32001`）で、tool へ進みません。ヘッダー無しの `initialize` / `tools/list` と読み取り tool は従来どおり使えます。
  - tool 入力の `role` / `principalId`・MCP session ID は認証情報として使いません。Grant は呼び出しごとに DB を読むため、取消は次の呼び出しから反映されます。Human 向け Web API は Task 42 以降 Web Session と Project Membership で認可し（後述の Step 6）、CLI は従来どおり Principal なしです。
- **実装済み（Task 16）**: Instruction 配信。repo 直下の `agent/role-policy.md`（共通 Policy）と `agent/strategist.md`（Role 文書）を `InstructionService` が読み、MCP `get_role_instructions({ role: "strategist", includeShared?: boolean })` が Wacha と同じ `{ role, includeShared, files: [{ path, kind: "shared" | "role", content }] }` で返します（`includeShared: true` で共通 Policy が先頭）。Bearer・Grant は不要です。ファイルを読めない場合は `INSTRUCTION_UNAVAILABLE`（対象 path 入り、`isError: true`）で、部分的な応答は返しません。`role` は `strategist`・`researcher`（Task 24）・`manager`・`worker`・`reviewer`（Task 33。Execution 用）・`evaluator`（Task 35。Outcome の評価用）・`runtime`（Task 31。Agent ではなく外部 Runtime 用の暫定 Role）で、Role を足すときは `ProjectRole` と `agent/<role>.md` の追加で同じ経路を使えます。Instruction を読んで動く Agent の自動起動（Runtime）は未接続です。
- **実装済み（Task 17）**: 自動統合検証（`test/strategistIntegration.test.ts`）。実 HTTP サーバー・CLI プロセス・MCP SDK client で、空 DB から Project・Intent（API）→ Grant（CLI / API）→ Instruction・Context・`create_outcome`（MCP + Bearer）→ Web 参照までを Human 操作なしで通し、権限なし・別 Project・取消済み・Bearer なし・Role 不一致・Instruction 欠落の拒否と、同じ DB・同じ port での再起動後の Grant 保持を確認します。MCP には Grant 管理 tool を設けないため、Human の Grant 発行は Web UI（Project 詳細の Strategist section）で行い、この自動検証は Web API / CLI で発行します。Runtime による Agent の自律起動は未接続で、テスト内の MCP client は自律運転の実証ではありません。

Step 5 の Project archive（active → archived の不可逆な遷移、理由の保持、archived 時に拒否する操作と参照できる操作）の設計と実装状況は [docs/step-5-project-archive-design.md](docs/step-5-project-archive-design.md) に記載しています。**永続化・共通 use case・Web API・状態ガードは実装済み**（Task 20）です。`POST /api/projects/:projectId/archive`（本文 `{ "reason": "..." }`）で archive し、`GET /api/projects` は active のみ、`GET /api/projects?status=archived` は archived のみを返します。archived の Project への書込（Project 更新、Intent / Outcome の変更、Grant の発行・取消）は Web API・MCP・CLI とも 409 `CONFLICT`（`projectStatus: "archived"`）で拒否し、参照は成功します。**Web UI も実装済み**（Task 21）です。Project 詳細の「アーカイブ」から、理由（必須）を入力する確認パネルを経て archive でき、Project 一覧の「アーカイブ済み」へ切り替えると理由と日時つきで参照できます。archived の詳細は状態・理由・日時を表示し、Project 編集・Intent / Outcome の登録・変更・Agent / Runtime の Role の割当変更の導線を出しません（拒否はサーバーが行い、編集 URL へ直接アクセスして保存しても「アーカイブ済みのため変更できません」と表示され内容は変わりません）。archive は Web API だけに公開し、MCP tool と CLI には追加しません（復帰・削除も作りません）。

Step 6 の Human 認証（Google OIDC、closed registration、Web Session・CSRF、Project Membership と owner / administrator / editor / viewer の権限表、招待、既存 Project の移行）の設計は [docs/step-6-human-auth-design.md](docs/step-6-human-auth-design.md) に記載しています（Task 39 で設計確定）。Task 40 で Human・Identity・Session・Membership・招待の永続化と application use case を実装しました。Task 41 で Google OIDC（authorization code + PKCE、server 側での code 交換と ID Token の署名・issuer・audience・exp・iat・nonce 検証）、closed registration による初期 owner の bootstrap、Compass 独自の Web Session Cookie（`HttpOnly`・`SameSite=Lax`、remote は `__Host-` と `Secure`）、`POST /auth/google/login`・`GET /auth/google/callback`・`POST /auth/local/login`（trusted-local のみ）・`GET /api/auth/session`・`POST /api/auth/logout`（CSRF 必須）と、起動時の設定検査を実装しました。拒否は `/login?error=not_allowed|invitation_expired|oidc_failed` へ redirect します（画面は Task 43）。Task 42 で Human 向け `/api/*`（Project・Intent・Outcome・Research / Decision / ADR 参照・Execution Summary・Agent Grant・Membership・招待）へ Session と Membership 認可を適用しました。Session 無しは `401`、未所属・取消済み・存在しない Project は区別せず `404`、Role 不足は `403`（`requiredRole` 付き）、非安全 method は CSRF（`X-Compass-CSRF` と Origin）必須です。`GET /api/projects` は所属 Project だけを返し、`POST /api/projects` の作成者は owner になり、`GET /api/projects/:projectId` は `myRole` を返します。Membership・招待の Web API（`GET|PATCH|DELETE /api/projects/:projectId/members[/:membershipId]`、`GET|POST|DELETE /api/projects/:projectId/invitations[/:invitationId]`）も追加しました。CORS は Bearer で呼ぶ `/mcp` と Runtime 向け API にだけ許します。Runtime 向け API（`runtime-events`・`execution-evidence`）は Session では認可せず Bearer だけを受け付けます。Task 43 で Web UI のログイン画面（`/login`。Google と、trusted-local だけの開発用ログイン）、招待リンク画面（`/invite#<token>`）、Session 復元・logout・Session 切れの再ログイン案内、Project 詳細の Member 画面（owner だけが招待・Role 変更・取消を行え、招待リンクは発行直後だけ表示）を実装しました。ログイン画面が表示するログイン方法は `GET /api/auth/methods` で取得します。remote mode の `/mcp` は Human 向け Command（`create_project`・`update_project`・`create_intent`・`update_intent`・`abandon_intent`）を登録せず、Authorization 無しの呼出しには `get_role_instructions` だけを公開します（Task 42）。trusted-local の `/mcp` は従来どおりです。Task 37 で Agent / Runtime Credential を実装し、remote mode の `/mcp` と Runtime 向け API は Agent 名だけの Bearer を `401` で拒否します（下記「Agent・Runtime Credential」）。

### Agent・Runtime Credential（Task 37）

Human の Google Session とは別に、Agent と外部 Runtime は Compass が発行する不透明 token（`Authorization: Bearer cmp_agent.<id>.<secret>` / `cmp_runtime.<id>.<secret>`、secret は 256bit 乱数）で認証します。

- **発行・rotation・取消・一覧**: Project の Administrator 以上が Web UI（Project 詳細の「Agent・Runtime Credential」）から行います。Web API は `GET|POST /api/projects/:projectId/credentials`（本文 `{ kind: "agent" | "runtime", principalId, scopes?, expiresInDays? }`。期限は 1〜365 日・既定 90 日）、`POST .../credentials/:credentialId/rotate`（`{ graceHours?, expiresInDays? }`。旧 Credential は既定 24 時間・最大 7 日だけ併用でき、0 なら即時失効）、`DELETE .../credentials/:credentialId`（冪等。次の呼出しから拒否）です。MCP には公開せず、Agent・Runtime が自分の権限を広げることはできません。archived の Project では発行・rotation は `409`、取消はできます。
- **secret の扱い**: token は発行・rotation の応答（`Cache-Control: no-store`）で一度だけ返し、DB には Credential ID・表示用 prefix・secret の SHA-256・Principal・種別・scope・期限・取消・最終利用日時だけを保存します。一覧・エラー・Change Log・MCP 結果に token は出ません。
- **Agent Credential**: 解決した Principal の Project Role Grant で認可します。発行した Project に束縛し、同じ Agent 名が別 Project の Grant・有効な Agent Credential を持つ場合は発行・Grant とも `409`（`conflict: PRINCIPAL_BOUND_ELSEWHERE`）です。remote mode の `list_projects` は Grant の有る Project だけを返し、`get_project` / `list_intents` / `get_intent` / `list_outcomes` / `get_outcome` / `list_adr_references` はその Project の何らかの Grant を要求します（無ければ `FORBIDDEN`）。
- **Runtime Credential**: Role Grant を使わず、発行 Project と明示 scope だけで認可します。`runtime:event:read`（`fetch_runtime_events` / `GET .../runtime-events`）、`runtime:event:ack`（ack）、`execution:change:read`（`list_changes`）、`execution:evidence:write`（`record_execution_evidence`）、`execution:summary:read`（`get_outcome_execution_summary`）。Runtime 名（`principalId`）が consumer になります。
- **拒否**: Bearer なし・形式不正・未知 ID・改ざん・種別違い・期限切れ・取消済みは `401 UNAUTHENTICATED`（理由を区別しません）。scope 不足・別 Project・Agent Credential での Runtime 操作は `403 FORBIDDEN`（`requiredScope` 付き）、Runtime Credential で Agent 向け tool を呼ぶと `UNAUTHENTICATED` です。
- **trusted-local**: 明示設定かつ loopback bind の開発 mode だけ、従来の Agent 名 Bearer（Runtime は `runtime` Role Grant）も受け付けます。`cmp_` で始まる Bearer は trusted-local でも Credential として検証し、Agent 名へ降格しません。remote mode で安全でない設定（http origin・Google 設定の欠落・`NODE_ENV=production` の trusted-local 等）は起動を拒否します。
- **未接続**: 実 Runtime・Agent からの利用と Lv6 閉ループ（Task 38）。`runtime` Role Grant は trusted-local の開発用に残し、Web UI の Runtime Grant section は Credential 管理に置き換えました（Web API / CLI の Grant 操作は残っています）。

Project単位のResearch蓄積、Intent起点のResearch Request、Finding / Synthesis / Intent Briefによる段階圧縮、Direction DecisionとRepository ADRの責務分離は [docs/research-decision-adr-design.md](docs/research-decision-adr-design.md) に設計方針を記載しています。Research Request・Result・Finding・Evidence参照・Synthesisのdomain・永続化・application層は実装済み（Task 23）で、MCPからはResearcherが使えます（Task 24）。Active Intent作成時のInitial Research Requestと、`research_requested` / `research_completed`のRuntime向け確定イベントも実装済みです（Task 25）。Web UI・Web API・MCPのどの入口から`create_intent`を呼んでも、同一transactionでIntentとInitial Requestが保存され、片方だけ残りません。Runtime向けイベントは、外部Runtimeがconsumer単位でcursor付きに取得し、処理結果をackする入口をWeb API（`GET /api/projects/:projectId/runtime-events`・`POST /api/projects/:projectId/runtime-events/:eventId/ack`）とMCP（`fetch_runtime_events`・`ack_runtime_event`）に実装済みです（Task 31。詳細は後述の「Runtime event の取得と ack」）。Runtimeによる実際のAgent起動は未接続です。Intent Brief（Task 26）、Direction Decision（Task 27）、ADR Candidate・Repository参照・Wacha引き渡し契約（Task 28）は実装済みです。Human向けのResearch・Direction Decision・ADR参照の読み取り専用Web UI/API、ResearcherのGrant管理画面の統合、および空DBからIntent → Initial Research Request → Researcher Result/Synthesis → Intent Brief → Strategist Decision/Outcome → ADR handoff/参照までを実HTTPサーバー・MCP SDK clientで自動検証する`test/researchDecisionIntegration.test.ts`はTask 29で実装済みです。外部Runtimeと実Wachaは未接続で、この自動検証と画面はfixture契約の確認であり、Lv6の自律運転実証ではありません。同文書の段階的な実装順に進めます。

### Runtime event の取得と ack（Task 31）

外部 Runtime が Agent の起動条件（`research_requested` → Researcher、`research_completed` → Strategist、`outcome_confirmed` → Manager、`outcome_evaluated` → Strategist）を取得する入口です。Compass は Agent を起動せず、polling 間隔・backoff・retry 上限は Runtime の責務です。認可は Runtime Credential の scope（Task 37。上記「Agent・Runtime Credential」）で、Credential の Runtime 名が consumer になり、consumer ごとに ack が独立します。trusted-local mode だけは、Runtime 名の Bearer と `runtime` Role Grant（Web API / CLI で発行）でも呼べます。

```bash
# 未処理イベントの取得（cursor 昇順。afterCursor は既定 0、limit は 1〜500・既定 100）
curl -H 'Authorization: Bearer cmp_runtime.<id>.<secret>' 'localhost:51800/api/projects/<projectId>/runtime-events?afterCursor=0&limit=100'
#   => { "events": [{ "cursor", "id", "version", "type", "projectId", "intentId", "researchRequestId", "correlationId", "conclusion", "occurredAt", "retryCount", "lastFailureReason" }], "nextCursor": 12, "resumeCursor": 10 }

# 処理結果の記録。attemptId は処理試行ごとに Runtime が生成する。outcome は processed / retryable_failure / terminal_failure（失敗は reason 必須）
curl -X POST -H 'Authorization: Bearer cmp_runtime.<id>.<secret>' -H 'Content-Type: application/json' \
  localhost:51800/api/projects/<projectId>/runtime-events/<eventId>/ack -d '{"attemptId":"<uuid>","outcome":"processed"}'
#   => { "delivery": {...}, "recorded": true }
```

- 取得は状態を変えない読取です。ack が無い、または `retryable_failure` のイベントだけを返し、`processed` / `terminal_failure` は返しません。応答が失われても同じ取得で同じイベントが返り、欠落しません。配送は at-least-once のため、Runtime はイベントの `id` で重複を判定します。
- `nextCursor` は同じ取得周回のページ送り専用です。未 ack・`retryable_failure` のイベントを追い越すため、永続化して再開に使いません。再起動後の再開には `resumeCursor`（その consumer にとって、それ以下のイベントがすべて `processed` / `terminal_failure` である最大の cursor）を永続化して `afterCursor` に渡します。`afterCursor=0`（省略）から取得し直しても、確定済み以外だけが返り欠落しません（server 再起動後も ack は SQLite に残ります）。
- ack の `attemptId` は Runtime が 1 回の処理試行ごとに生成し、応答消失後の再送では同じ値を使います。同じイベント・同じ `attemptId` の再送は初回の結果を返して状態を変えず（`recorded: false`、`retryCount` も増えない）、同じ `attemptId` で別の結果・理由を送ると `409 CONFLICT` です。新しい試行には新しい `attemptId` を使い、`retryCount` はその試行ごとに数えます。確定済みのイベントへ同じ結果を送り直しても状態は変わりません（`recorded: false`）。`processed` / `terminal_failure` 済みに別の結果を送ると `409 CONFLICT`、`retryable_failure` からは任意の結果へ進めます。別 Project のイベントは `404 NOT_FOUND`、Bearer なし・形式不正は `401 UNAUTHENTICATED`、runtime Grant なし（別 Project・取消済み・他の Role のみ）は `403 FORBIDDEN` です。
- `research_completed` は `projectId`・`intentId`・`researchRequestId`（Request の ID）・`correlationId`・`version`・`conclusion` を持ち、Strategist の起動に必要な項目を揃えています。
- `outcome_confirmed`（Task 33）は `create_outcome` / `decide_next_outcome` が Outcome を保存する同じ transaction で 1 件だけ保存され、`projectId`・`intentId`・`outcomeId`・`correlationId`（`outcome:<outcomeId>`）・`version` を持ちます（`researchRequestId` は `null`、research 系イベントの `outcomeId` は `null`）。Manager の起動条件で、Compass は Story を自動では作りません（後述の「Execution」）。
- `outcome_evaluated`（Task 36）は `record_outcome_evaluation` が Evaluation を保存する同じ transaction で、Evaluation ごとに 1 件だけ保存され、`outcomeId`・`evaluationId`・`correlationId`（`outcome:<outcomeId>`）を持ちます。Strategist の起動条件で、Compass は再計画・Intent 完了を自動では決めません。
- MCP は同じ use case を `fetch_runtime_events`・`ack_runtime_event`（入力は `projectId` と上記の項目）として公開します。Runtime 向けの手順は `get_role_instructions({ role: "runtime" })`（`agent/runtime.md`）にあります。
- 未接続・未検証: 実際の外部 Runtime による取得・Agent 起動は未接続です。検証は Web API / MCP の in-process 呼び出し（`test/runtimeEvents.test.ts`）で、Lv6 の自律運転の実証ではありません。`outcome_confirmed` を受けた Manager の起動も同様に未接続です。既存 DB の `runtime_event` は、起動時（`initializeSchema`）に SQLite 公式手順で table を作り直して `outcome_confirmed` を受け付けるようにします（event・cursor・ack は保持され、再実行しても変わりません）。Task 36 以前の DB も同じ手順で `outcome_evaluated` と `evaluation_id` 列を受け付けるように作り直し、`direction_decision` には `evaluation_id` 列を追加します。

### Project Role Grant（Strategist / Researcher / Manager / Worker / Reviewer / Evaluator / Runtime）の操作

Grant は Agent を起動しません。「この Agent 名が、この Project でその Role として振る舞ってよい」という記録です。HumanはProject詳細のWeb UI（Strategist・Researcher・Manager・Worker・Reviewer・Evaluator・Runtimeの各section。共通のGrant Section実装を再利用し、Manager・Worker・ReviewerはTask 33、Evaluator・RuntimeはTask 35で追加。archivedのProjectでは一覧のみ）から発行・取消します。Web APIはWeb UIの接続面で、Session と Membership（一覧は viewer 以上、発行・取消は administrator 以上）で認可します（Task 42）。CLIはローカル開発・保守・自動検証用で、認証はありません。

```bash
# Web API（Web UI用。server 起動中。role は strategist / researcher / manager / worker / reviewer / evaluator / runtime。いずれも Project 詳細の Web UI から発行できます）
# Session Cookie・CSRF token（GET /api/auth/session の csrfToken）・Origin が必要です（Task 42）
curl -X POST localhost:51800/api/projects/<projectId>/grants -b 'compass_session=<session>' \
  -H 'Origin: http://localhost:51800' -H 'X-Compass-CSRF: <csrfToken>' \
  -H 'Content-Type: application/json' -d '{"principalId":"strategist-agent","role":"strategist"}'   # 新規 201 / 既存 200
curl localhost:51800/api/projects/<projectId>/grants -b 'compass_session=<session>'                   # { "grants": [...] }
curl -X DELETE localhost:51800/api/projects/<projectId>/grants/strategist/strategist-agent -b 'compass_session=<session>' \
  -H 'Origin: http://localhost:51800' -H 'X-Compass-CSRF: <csrfToken>'                                # { "revoked": true | false }

# CLI（ローカル開発・保守用。server 停止中でも動作し、COMPASS_DB_PATH の SQLite file を直接使う）
npm run cli -- grant  <projectId> <AgentName> strategist
npm run cli -- revoke <projectId> <AgentName> strategist
npm run cli -- grants <projectId>
```

CLI の標準出力は Web API と同じ形の JSON です。失敗は標準エラーの `{ "error": { "code", "message" } }` で、終了コードは成功 `0`（存在しない Grant の取消も `0`）、検証・存在エラー `1`、引数不足・未知のコマンド `2` です。再発行は重複せず、存在しない Project は `NOT_FOUND`、空・101 文字以上・制御文字を含む Agent 名と `strategist` / `researcher` / `manager` / `worker` / `reviewer` / `evaluator` / `runtime` 以外の role は `VALIDATION_ERROR` になります。

Coordination and Operations Management Platform for Autonomous Software Systems
