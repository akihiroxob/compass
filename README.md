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
Step 2 の Intent 初期仕様は [docs/step-2-intent-design.md](docs/step-2-intent-design.md) に記載しています（仕様は確定済みで、Intent の実装は Task 08 で行います。未実装の間は Project 機能のみ利用できます）。事前のユーザー確認は設けず、完成後のフィードバックに応じて修正します。
Coordination and Operations Management Platform for Autonomous Software Systems
