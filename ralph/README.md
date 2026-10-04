# Compass Ralph

Compass の Work（Story / Task）の現在状態を監視し、Claude Code または Codex の Worker・Reviewer を1 Task ずつ使い捨てで起動する Loop Application です。Server とは独立して実行・deploy し、Server とは MCP（`/mcp`）だけで接続します。Server の DB・package は直接使いません。bash で実装しています。

## 責務

- Ralph: Task の有無の確認（`list_tasks` の `availableFor`）、Agent プロセスの起動、失敗時の待機と再試行
- Compass Server: Task・Claim・Review の状態、認可、自己レビュー禁止の強制
- 起動された Agent: `get_role_context` で Role Context を取得し、その指示に従って Task を処理し、Task Comment と状態遷移で結果を Compass へ返す
- Agent provider（`providers/`）: Claude Code・Codex 固有の起動処理

Ralph は Role の手順・Skill 本文を持ちません。`prompts/` は対象 Project と Role Context の取得を指示するだけの起動指示です。Role 本文は repo の `roles/` を正本として MCP から取得されます。Story への分解や最終受入（manager）は Ralph の対象外です。

## Principal と Credential

Worker と Reviewer は別 Principal・別 Credential で接続します。Project 詳細（Web UI）で、例えば次の Agent に Grant を付け、同じ Agent 名の Agent Credential を発行します。

| Agent 名（例） | Grant | 設定の `tokenEnv`（例） |
| --- | --- | --- |
| `ralph-worker` | `worker` | `COMPASS_RALPH_WORKER_TOKEN` |
| `ralph-reviewer` | `reviewer` | `COMPASS_RALPH_REVIEWER_TOKEN` |

- Server へは常に `X-Compass-Active-Role: worker` / `reviewer` を送り、その Role の Grant だけで認可させます
- Worker と Reviewer の `tokenEnv` が同じ、または token の値が同じ場合は起動を拒否します。同じ Principal の別 Credential は Ralph では判別できませんが、自己レビューは Server（Work）が拒否します
- Ralph は token を読んだ後に自身の環境変数から `tokenEnv` を消し、起動する Agent へはその Role の token だけを `COMPASS_RALPH_TOKEN` で渡します。Worker の Agent は Reviewer の token を読めません
- token は curl の引数・Agent の MCP 設定 file に書きません（curl は private な一時 directory の header file、Claude Code は `${COMPASS_RALPH_TOKEN}` の展開、Codex は `bearer_token_env_var` で読みます）
- trusted-local の Server では、token の代わりに Agent 名そのものを使えます

## 設定

設定は JSON file で渡します（[examples/config.json](examples/config.json)）。稼働中の既存 Ralph（agent-foundation から install し `.ralph/config.json` を読むもの）と混同しないよう、既定の設定 path は持ちません。`--config` または `COMPASS_RALPH_CONFIG` で指定します。

| 項目 | 内容 |
| --- | --- |
| `serverUrl` | Compass Server の URL。MCP は `<serverUrl>/mcp` |
| `projectId` | 対象 Project の ID |
| `projectRoot` | Agent を起動する作業 directory。設定 file の directory からの相対 path。省略時は Ralph を起動した directory |
| `agentProvider` | 既定の provider（`claude` / `codex`）。省略時は `claude` |
| `pollIntervalSeconds` | 対象が無いときの確認間隔（既定 300） |
| `retry.initialSeconds` | Agent の失敗・状態取得の失敗・状態が変わらなかったときの待機（既定 300） |
| `retry.tokenLimitSeconds` | Token 上限を検出したときの待機（既定 1800。Claude Code の reset 時刻を読めればそれを使う） |
| `logging.path` | Operational Log。`projectRoot` からの相対 path（既定 `.compass-ralph/logs/ralph.log`） |
| `claude.command`・`claude.dangerouslySkipPermissions` | Claude Code の実行 file と権限確認の省略 |
| `codex.command`・`codex.dangerouslyBypassApprovalsAndSandbox` | Codex の実行 file と sandbox の省略（`false` なら `--sandbox workspace-write`） |
| `roles.<worker\|reviewer>.tokenEnv` | その Role の token を読む環境変数名（値は書かない） |
| `roles.<role>.agentProvider`・`command`・`model`・`prompt` | Role ごとの provider・実行 file・model・起動指示 file（`prompt` は設定 file からの相対 path） |

Claude Code は `--mcp-config`（実行ごとの一時 file）と `--strict-mcp-config` で起動し、Compass MCP（`mcp__compass`）だけを読み込みます。Codex は `-c mcp_servers.compass.*` で Compass MCP を追加します。Codex は利用者の global 設定にある他の MCP server も読み込むため、Codex 側の設定に開発支援 Wacha 等がある場合は Agent から見えます。

Log は JSON ではなく1行ずつの text で、stdout / stderr と `logging.path` に出します。Compass の Activity・Change Log には書きません。

## 実行・build・deploy

依存は bash（3.2 以上）・`jq`・`curl`、provider の実行 file（`claude` / `codex`）、Claude Code の Token 上限の reset 時刻を読む `python3` です。npm の依存はテストだけが使います。

```bash
export COMPASS_RALPH_WORKER_TOKEN="cmp_agent.<id>.<secret>"
export COMPASS_RALPH_REVIEWER_TOKEN="cmp_agent.<id>.<secret>"
# reviewer → worker の順に対象を確認して起動し続ける（SIGINT / SIGTERM で終了）
ralph/bin/ralph run --config /path/to/ralph.json
# 片方の Role だけを監視する
ralph/bin/ralph run worker --config /path/to/ralph.json
# 対象があれば1回だけ起動して終了を待つ（cron 等の scheduler 向け。対象なしは 0、Agent の失敗は 1）
ralph/bin/ralph run auto --once --config /path/to/ralph.json
```

- 1回の起動で Agent は Task を最大1件処理します。起動後も状態が変わらなければ `retry.initialSeconds` 待ちます
- Agent が 0 以外で終了した場合は、Token 上限なら `retry.tokenLimitSeconds`（auto ではその Role だけを待たせ、他の Role を確認）、それ以外は `retry.initialSeconds` 待って再試行します
- SIGTERM を受けると次の Agent を起動しません。Agent の実行中なら Agent の終了を待ってから終了します（待機中ならすぐ終了）。端末の Ctrl-C は Agent にも届きます
- Agent が途中で停止した場合も、Claim は期限（Server の `COMPASS_CLAIM_TTL_MS`）が切れると `availableFor: "work"` に戻り、次の起動で別の Claim として再取得されます。Ralph は Claim を保持・更新しません

`npm run build --workspace ralph` は shell script の構文検査で、出力 file は作りません。deploy 先に `ralph/` を置き（repo ごとでも可）、設定 file と環境変数を用意して上記コマンドを scheduler または process manager から起動します。Agent が作業する repository は `projectRoot` で指定します。

## 検証

```bash
npm test --workspace ralph
npm run typecheck --workspace ralph
npm run lint --workspace ralph
```

`tests/ralph.test.ts` は Server（trusted-local・一時 DB・一時 cwd で、親の `COMPASS_*`・`PORT` を引き継がない）と Ralph を別プロセスで起動し、次を確認します。

- Worker（claude provider）と Reviewer（codex provider）が別 Principal・別 Credential と `X-Compass-Active-Role` で接続し、`get_role_context` の取得、作業結果（Comment・`in_review`）、レビュー結果（Comment・`wait_accept`）が MCP で返る。Agent から `tokenEnv` が見えない
- Worker と Reviewer に同じ Credential を設定すると起動しない
- provider の失敗後の再試行、Claim を残して停止した Agent の Task を Claim 期限後に再取得して完了・レビューまで進む
- Token 上限の検出、Agent 実行中の SIGTERM で Agent の終了を待ち次を起動しない

起動される Agent は決定的な fixture（`tests/support/fakeAgent.ts`。`claude` / `codex` の引数から MCP 接続設定を読む）で、実 Agent による自律運転の実証ではありません。

## 未接続・未検証

- 実 Agent（Claude Code・Codex）が Compass の Task を処理するループは未検証。実 CLI については、`--mcp-config` の `${COMPASS_RALPH_TOKEN}` 展開（Claude Code）と `bearer_token_env_var`・`http_headers`（Codex）で Authorization・`X-Compass-Active-Role` が送られることだけを手動で確認した
- 同じ Project を複数の Ralph で監視した場合の Agent の重複起動は抑止しない（Task の排他は Server の Claim が保証する）
- remote mode の Server と Agent Credential での接続は自動テストの対象外
