# Workers + D1への配置

Compass ServerはWorkersでWeb UI・Web API・MCPを提供する。Node＋SQLiteの開発起動は`npm start`／`npm run dev`を使う。RalphとOrchestratorは別プロセスとして実行し、配置したServerへ接続する。

## 配布物

`npm run worker:build`はWeb UI、Agent文書、Workerをビルドし、Wranglerのdry-runで検査する。CloudflareへのアップロードやDB変更は行わない。

- Worker entry: `server/src/worker.ts`。
- D1用の構成: `server/src/bootstrap/createWorkersApplication.ts`。
- 設定: `wrangler.jsonc`。
- 生成するentry・文書・bundle: `server/.generated/`。Git管理しない。
- Web UI: `server/public/`。ASSETS binding経由で配信する。

Role・Skill・Knowledge・Policyは`roles/`・`skills/`・`knowledge/`・`policies/`のMarkdownをビルド時に同梱する。実行時にGitやサーバーのfilesystemから更新を取得しない。配信元revisionは`COMPASS_DEPLOY_REVISION`、未指定時はWorkers Buildsの`WORKERS_CI_COMMIT_SHA`を使い、有効な40桁SHAでなければ不明とする。文書の内容はrevisionの有無に関係なく、そのデプロイに含まれるものを配信する。

## D1の準備

Cloudflareへログインし、D1を作成する。

```sh
npx wrangler login
npx wrangler d1 create compass
```

返されたIDを`wrangler.jsonc`の`d1_databases[0].database_id`へ設定する。初期値の全桁ゼロはローカル検証用で、実DBのIDではない。

マイグレーションは配置・起動とは独立して明示実行する。

```sh
npm run db:migrate:d1:local
npm run db:migrate:d1:remote
```

`local`はWranglerのローカルD1、`remote`は設定したCloudflareのDBへ適用する。両コマンドは先に`npm run db:prepare:d1`で配布SQLを生成する。Wranglerの`d1_migrations`が適用履歴を保持する。Node＋SQLiteの`COMPASS_DB_PATH`や`compass_schema_migration`とは別管理になる。Serverと`worker:dev`・`worker:deploy`はschema作成・migrationを実行しない。未適用DBを起動しても初期化しない。

## Human・Agentの認証

WorkersのHuman認証はremote mode固定。GoogleのOAuthクライアントにはWebアプリケーションを選び、リダイレクトURIとして`https://<公開ホスト>/auth/google/callback`を登録する。

Workerの環境変数に以下を設定する。

| 名前 | 内容 |
| --- | --- |
| `COMPASS_PUBLIC_ORIGIN` | HTTPSの公開origin。path・queryは含めない |
| `COMPASS_GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `COMPASS_INITIAL_OWNER_EMAIL` | 初回platform ownerのGoogleメール。owner作成前は必須 |

SecretはWorkerの設定または以下の対話コマンドから登録する。値をGitへ置かない。

```sh
npx wrangler secret put COMPASS_GOOGLE_CLIENT_SECRET
npx wrangler secret put COMPASS_GITHUB_TOKEN
```

GitHub tokenはPR／commit照合が必要なRepositoryへの読取用で、不要なら省略できる。`keep_vars`でDashboard上の環境変数を配置後も維持する。SecretとBuild用の環境変数は別管理。

AgentはGoogleログインを使わず、Compassで発行したAgent CredentialをBearerとして`https://<公開ホスト>/mcp`へ接続する。PrincipalのRole Grant・Credential scope・activeRoleによる制限はNode版と同じ。

## ローカルWorkers検証

`.dev.vars`に同じ変数・Secretを設定し、明示migrationの後で起動する。Workers版もremote modeなので、Google callbackへ戻れるHTTPSの検証originが必要。通常のローカル開発は既存のNode版trusted-localを使える。

```sh
npm run db:migrate:d1:local
npm run worker:dev
```

`node --import tsx --test tests/integration/workersRuntime.test.ts`は、配布bundleをworkerdで実行する。外部OIDC通信を署名付きfixtureへ置き換える検証で、実Googleアカウントへの接続・Cloudflare実環境の疎通とは区別する。

## mainへのPushから配置

CloudflareのWorkers BuildsへGitHub Repositoryを接続し、production branchを`main`、root directoryをRepositoryルートにする。Build commandを`npm run worker:prepare`、Deploy commandを`npm run worker:deploy`に設定する。Build用のinstallには開発依存も必要。

Wrangler単独実行では`build.command`が配布物を準備する。Workers BuildsではBuild commandにも同じ処理を指定する。DBへのmigrationは自動配置コマンドへ混ぜず、必要なschemaを配置前に明示適用しておく。

初回はD1 ID・環境変数・Secretを設定し、remote migrationを適用してから配置する。

```sh
npm run worker:deploy
```

配置後は`/health`、Googleログイン、Workspace作成／閲覧、Agent CredentialによるMCPのRole Context取得とTask操作を確認する。環境設定・DB接続・bootstrapが成立しなければ503を返す。`/health`の成功だけでGoogleやGitHubとの外部接続まで検証済みとは扱わない。

## 保存の整合性と制約

D1はSQL前提条件・変更・Receipt・Activityを原子的batchで確定する。callback型DB transactionは提供しない。前提条件が変わった場合のみ上限付きで再読取し、通信断など成否不明の書込を無条件に再実行しない。受付記録のある操作は同じrequest IDで照合する。

D1のSQL長・bind数・文字列値・SQL関数引数には上限がある。保存前の検査と保存予定行の参照は、小分けのJSONや元の値を用いてSQLを組み立てる。これらの断片も一つの原子的batchで確定し、途中までの保存を許さない。Activityのliteral部分一致はLIKE patternの上限に依存しないSQLを使う。

D1とWorkersの実行時間・値サイズ・bind数・query数には上限がある。大量データの移行や大規模な一括更新を通常の操作と同じ負荷で扱える保証はない。実データ量に応じて確認する。

参照: [Workers静的配信設定](https://developers.cloudflare.com/workers/static-assets/binding/)、[Workers Builds設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[D1上限](https://developers.cloudflare.com/d1/platform/limits/)。
