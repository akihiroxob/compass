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

既定 port は `51800` です（Wacha の既定 port `51743` とは衝突しないため、Wacha と同時に起動できます）。環境変数は [.env.example](.env.example) を参照してください。`PORT` で port、`COMPASS_DB_PATH` で Project を保存する SQLite file を指定します。

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
Strategistには `Authorization: Bearer <AgentName>` が必要です。ここで指定するAgent名は、後述の
Project Role Grantに登録するAgent名と一致させてください。

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
5. `get_strategist_context({ projectId })`でProject、Active Intent、既存Outcomeを取得する。
6. 情報が十分なら`create_outcome`でOutcomeと成功条件を登録する。

例えば、接続したAgentへ次のように依頼できます。

```text
Compass MCPを使い、Project <projectId> のStrategist InstructionとContextを読んでください。
Intentを達成するための情報が十分なら、Outcomeと成功条件を作成してください。
不足している場合はOutcomeを作らず、必要な情報とResearchすべき問いを報告してください。
```

`get_role_instructions`はBearer・Grantを必要としません。`get_strategist_context`と`create_outcome`はBearerがないと`UNAUTHENTICATED`、そのProjectのStrategist Grantがないと`FORBIDDEN`になります。Agent名の不一致を疑うときは、Project詳細のStrategist欄で割当済みのAgent名を確認してください。

Research Request・Result・Finding・Evidence参照・Synthesisのdomain・永続化・application層は実装済みですが（Task 23）、
Web API・MCP・Web UIへは未接続で、Researcherの起動も未実装です。`get_strategist_context`の`research`も`unavailable`のままです。
現時点ではStrategistが情報不足を報告し、根拠を推測で補わないところまでをInstructionで定めています。

## 検証

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Step 1 の Project 仕様は [docs/step-1-project-design.md](docs/step-1-project-design.md) に記載しています。
Step 2 の Intent 仕様と実装状況・検証手順は [docs/step-2-intent-design.md](docs/step-2-intent-design.md) に記載しています。Intent は Project 配下に保存され、Web UI（Project 詳細の Intent section）、Web API（`/api/projects/:projectId/intents`）、MCP（`create_intent` / `list_intents` / `get_intent` / `update_intent` / `abandon_intent`）から作成・参照・更新・放棄できます。Strategist の Role Grant・Instruction・認可は Step 4 で実装済みですが（後述）、Runtime による Strategist の自動起動と Research は未実装です（Outcome は Step 3 で追加）。事前のユーザー確認は設けず、完成後のフィードバックに応じて修正します。

Step 3 の Outcome と成功条件の仕様と実装状況・検証手順は [docs/step-3-outcome-design.md](docs/step-3-outcome-design.md) に記載しています。Outcome は Intent 配下に成功条件（1〜10件、作成時に固定）とともに保存され、Web UI（Intent 詳細の Outcome section、Project 詳細の Active Outcomes）、Web API（`/api/projects/:projectId/intents/:intentId/outcomes`）、MCP（`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`。書込は Step 4 以降 Strategist Grant と Bearer が必要）から作成・参照・更新（title・hypothesis のみ）・取消できます。Intent から Outcome は自動生成されず、Evaluation・Execution・Wacha 連携・Strategist の自動起動は未実装です。

Step 4 の Strategist Role と認可境界（Project 単位の Role Grant、`Authorization: Bearer <AgentName>` による MCP の Principal 解決、Grant の Command API・CLI、Instruction 配信）は [docs/step-4-strategist-role-design.md](docs/step-4-strategist-role-design.md) に設計を記載しています。

- **実装済み（Task 14）**: Strategist の Role Grant の永続化（SQLite `project_grant`）、Web API、CLI、Web UI（Project 詳細の Strategist section）。
- **実装済み（Task 15）**: MCP の Principal 解決と Strategist 認可。`Authorization: Bearer <AgentName>` の値をそのまま Principal とし（trusted-local。秘密の検証はなく、セキュリティ境界ではありません）、Grant で次を検査します。
  - `get_strategist_context`（Project・Active Intent・既存 Outcome を返す）と `create_outcome` / `update_outcome` / `cancel_outcome` は、その Project の Strategist Grant が必須です。Bearer なしは `UNAUTHENTICATED`、Grant 無し（別 Project・取消済み・存在しない Project を区別しない）は `FORBIDDEN` で、どちらも `isError: true` の tool 結果です。
  - その Project の Strategist Grant を持つ Principal は `update_project` / `create_intent` / `update_intent` / `abandon_intent` を `FORBIDDEN` で拒否されます（職務分離。Bearer なし・Grant なしは従来どおり成功）。
  - `Authorization` が有るのに形式不正（`Basic ...`、値なし、101 文字以上、制御文字）の `/mcp` は HTTP `401`（JSON-RPC `-32001`）で、tool へ進みません。ヘッダー無しの `initialize` / `tools/list` と読み取り tool は従来どおり使えます。
  - tool 入力の `role` / `principalId`・MCP session ID は認証情報として使いません。Grant は呼び出しごとに DB を読むため、取消は次の呼び出しから反映されます。Web API / CLI は従来どおり Principal なしです。
- **実装済み（Task 16）**: Instruction 配信。repo 直下の `agent/role-policy.md`（共通 Policy）と `agent/strategist.md`（Role 文書）を `InstructionService` が読み、MCP `get_role_instructions({ role: "strategist", includeShared?: boolean })` が Wacha と同じ `{ role, includeShared, files: [{ path, kind: "shared" | "role", content }] }` で返します（`includeShared: true` で共通 Policy が先頭）。Bearer・Grant は不要です。ファイルを読めない場合は `INSTRUCTION_UNAVAILABLE`（対象 path 入り、`isError: true`）で、部分的な応答は返しません。`role` は `strategist` のみで、Role を足すときは `ProjectRole` と `agent/<role>.md` の追加で同じ経路を使えます。Instruction を読んで動く Agent の自動起動（Runtime）は未接続です。
- **実装済み（Task 17）**: 自動統合検証（`test/strategistIntegration.test.ts`）。実 HTTP サーバー・CLI プロセス・MCP SDK client で、空 DB から Project・Intent（API）→ Grant（CLI / API）→ Instruction・Context・`create_outcome`（MCP + Bearer）→ Web 参照までを Human 操作なしで通し、権限なし・別 Project・取消済み・Bearer なし・Role 不一致・Instruction 欠落の拒否と、同じ DB・同じ port での再起動後の Grant 保持を確認します。MCP には Grant 管理 tool を設けないため、Human の Grant 発行は Web UI（Project 詳細の Strategist section）で行い、この自動検証は Web API / CLI で発行します。Runtime による Agent の自律起動は未接続で、テスト内の MCP client は自律運転の実証ではありません。

Step 5 の Project archive（active → archived の不可逆な遷移、理由の保持、archived 時に拒否する操作と参照できる操作）の設計と実装状況は [docs/step-5-project-archive-design.md](docs/step-5-project-archive-design.md) に記載しています。**永続化・共通 use case・Web API・状態ガードは実装済み**（Task 20）です。`POST /api/projects/:projectId/archive`（本文 `{ "reason": "..." }`）で archive し、`GET /api/projects` は active のみ、`GET /api/projects?status=archived` は archived のみを返します。archived の Project への書込（Project 更新、Intent / Outcome の変更、Grant の発行・取消）は Web API・MCP・CLI とも 409 `CONFLICT`（`projectStatus: "archived"`）で拒否し、参照は成功します。**Web UI も実装済み**（Task 21）です。Project 詳細の「アーカイブ」から、理由（必須）を入力する確認パネルを経て archive でき、Project 一覧の「アーカイブ済み」へ切り替えると理由と日時つきで参照できます。archived の詳細は状態・理由・日時を表示し、Project 編集・Intent / Outcome の登録・変更・Strategist の割当変更の導線を出しません（拒否はサーバーが行い、編集 URL へ直接アクセスして保存しても「アーカイブ済みのため変更できません」と表示され内容は変わりません）。archive は Web API だけに公開し、MCP tool と CLI には追加しません（復帰・削除も作りません）。

Project単位のResearch蓄積、Intent起点のResearch Request、Finding / Synthesis / Intent Briefによる段階圧縮、Direction DecisionとRepository ADRの責務分離は [docs/research-decision-adr-design.md](docs/research-decision-adr-design.md) に設計方針を記載しています。Research Request・Result・Finding・Evidence参照・Synthesisのdomain・永続化・application層は実装済み（Task 23）ですが、Web API・MCP・Web UIへは未接続です。Researcher Role、Runtimeイベント、Intent Brief、Decision、ADR連携は未実装であり、同文書の段階的な実装順に進めます。

### Strategist Grant の操作

Grant は Agent を起動しません。「この Agent 名が、この Project で Strategist として振る舞ってよい」という記録です。HumanはProject詳細のWeb UIから発行・取消します。Web APIはWeb UIと外部Runtimeの接続面、CLIはローカル開発・保守・自動検証用です。trusted-local を前提とし、認証はありません。

```bash
# Web API（Web UI・外部Runtime・自動検証用。server 起動中）
curl -X POST localhost:51800/api/projects/<projectId>/grants \
  -H 'Content-Type: application/json' -d '{"principalId":"strategist-agent","role":"strategist"}'   # 新規 201 / 既存 200
curl localhost:51800/api/projects/<projectId>/grants                                                  # { "grants": [...] }
curl -X DELETE localhost:51800/api/projects/<projectId>/grants/strategist/strategist-agent            # { "revoked": true | false }

# CLI（ローカル開発・保守用。server 停止中でも動作し、COMPASS_DB_PATH の SQLite file を直接使う）
npm run cli -- grant  <projectId> <AgentName> strategist
npm run cli -- revoke <projectId> <AgentName> strategist
npm run cli -- grants <projectId>
```

CLI の標準出力は Web API と同じ形の JSON です。失敗は標準エラーの `{ "error": { "code", "message" } }` で、終了コードは成功 `0`（存在しない Grant の取消も `0`）、検証・存在エラー `1`、引数不足・未知のコマンド `2` です。再発行は重複せず、存在しない Project は `NOT_FOUND`、空・101 文字以上・制御文字を含む Agent 名と `strategist` 以外の role は `VALIDATION_ERROR` になります。

Coordination and Operations Management Platform for Autonomous Software Systems
