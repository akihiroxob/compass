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

## 検証

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Step 1 の Project 仕様は [docs/step-1-project-design.md](docs/step-1-project-design.md) に記載しています。
Step 2 の Intent 仕様と実装状況・検証手順は [docs/step-2-intent-design.md](docs/step-2-intent-design.md) に記載しています。Intent は Project 配下に保存され、Web UI（Project 詳細の Intent section）、Web API（`/api/projects/:projectId/intents`）、MCP（`create_intent` / `list_intents` / `get_intent` / `update_intent` / `abandon_intent`）から作成・参照・更新・放棄できます。Strategist・Research は未実装です（Outcome は Step 3 で追加）。事前のユーザー確認は設けず、完成後のフィードバックに応じて修正します。

Step 3 の Outcome と成功条件の仕様と実装状況・検証手順は [docs/step-3-outcome-design.md](docs/step-3-outcome-design.md) に記載しています。Outcome は Intent 配下に成功条件（1〜10件、作成時に固定）とともに保存され、Web UI（Intent 詳細の Outcome section、Project 詳細の Active Outcomes）、Web API（`/api/projects/:projectId/intents/:intentId/outcomes`）、MCP（`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`。書込は Step 4 以降 Strategist Grant と Bearer が必要）から作成・参照・更新（title・hypothesis のみ）・取消できます。Intent から Outcome は自動生成されず、Evaluation・Execution・Wacha 連携・Strategist の自動起動は未実装です。

Step 4 の Strategist Role と認可境界（Project 単位の Role Grant、`Authorization: Bearer <AgentName>` による MCP の Principal 解決、Grant の Command API・CLI、Instruction 配信）は [docs/step-4-strategist-role-design.md](docs/step-4-strategist-role-design.md) に設計を記載しています。

- **実装済み（Task 14）**: Strategist の Role Grant の永続化（SQLite `project_grant`）、Web API、CLI、Web UI（Project 詳細の Strategist section）。
- **実装済み（Task 15）**: MCP の Principal 解決と Strategist 認可。`Authorization: Bearer <AgentName>` の値をそのまま Principal とし（trusted-local。秘密の検証はなく、セキュリティ境界ではありません）、Grant で次を検査します。
  - `get_strategist_context`（Project・Active Intent・既存 Outcome を返す）と `create_outcome` / `update_outcome` / `cancel_outcome` は、その Project の Strategist Grant が必須です。Bearer なしは `UNAUTHENTICATED`、Grant 無し（別 Project・取消済み・存在しない Project を区別しない）は `FORBIDDEN` で、どちらも `isError: true` の tool 結果です。
  - その Project の Strategist Grant を持つ Principal は `update_project` / `create_intent` / `update_intent` / `abandon_intent` を `FORBIDDEN` で拒否されます（職務分離。Bearer なし・Grant なしは従来どおり成功）。
  - `Authorization` が有るのに形式不正（`Basic ...`、値なし、101 文字以上、制御文字）の `/mcp` は HTTP `401`（JSON-RPC `-32001`）で、tool へ進みません。ヘッダー無しの `initialize` / `tools/list` と読み取り tool は従来どおり使えます。
  - tool 入力の `role` / `principalId`・MCP session ID は認証情報として使いません。Grant は呼び出しごとに DB を読むため、取消は次の呼び出しから反映されます。Web API / CLI は従来どおり Principal なしです。
- **未実装**: Instruction 配信（`get_role_instructions`、Task 16）、統合検証（Task 17）。

### Strategist Grant の操作

Grant は Agent を起動しません。「この Agent 名が、この Project で Strategist として振る舞ってよい」という記録です。Web API・CLI が自動化の正規入口で、Human の確認や画面操作は不要です（Web UI は同じ処理を使う任意の入口）。trusted-local を前提とし、認証はありません。

```bash
# Web API（server 起動中）
curl -X POST localhost:51800/api/projects/<projectId>/grants \
  -H 'Content-Type: application/json' -d '{"principalId":"strategist-agent","role":"strategist"}'   # 新規 201 / 既存 200
curl localhost:51800/api/projects/<projectId>/grants                                                  # { "grants": [...] }
curl -X DELETE localhost:51800/api/projects/<projectId>/grants/strategist/strategist-agent            # { "revoked": true | false }

# CLI（server 停止中でも動作。COMPASS_DB_PATH の SQLite file を直接使う）
npm run cli -- grant  <projectId> <AgentName> strategist
npm run cli -- revoke <projectId> <AgentName> strategist
npm run cli -- grants <projectId>
```

CLI の標準出力は Web API と同じ形の JSON です。失敗は標準エラーの `{ "error": { "code", "message" } }` で、終了コードは成功 `0`（存在しない Grant の取消も `0`）、検証・存在エラー `1`、引数不足・未知のコマンド `2` です。再発行は重複せず、存在しない Project は `NOT_FOUND`、空・101 文字以上・制御文字を含む Agent 名と `strategist` 以外の role は `VALIDATION_ERROR` になります。

Coordination and Operations Management Platform for Autonomous Software Systems
