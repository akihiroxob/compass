# Compass Orchestrator

Project 横断で Compass Server の現在状態を読み、次に起動すべき専門 Role の Agent を起動する Batch Application です。Server とは独立して実行・build・deploy し、Server とは MCP（`/mcp`）だけで接続します。Server の DB・package は直接使いません。

## 責務

- 明示的な状態判定だけを行い、起動対象を決める（[`src/plan.ts`](src/plan.ts)）。Outcome の内容・調査方法・Story / Task への分解などの知的判断は、起動された Role が行う
- 起動する Agent へは対象（`projectId`・Role・対象 ID）だけを渡す。Role の手順・判断基準は渡さず、Agent が `get_role_context` で取得する
- 起動判断は毎回 Server の現在状態（`get_orchestration_state`）から行う。Activity・Runtime event の cursor を workflow checkpoint にしない
- Direction / Work の状態を書き換えない（読むだけ）。Worker / Reviewer の実行ループは Ralph の責務

| 現在状態 | 起動する Role | 対象 |
| --- | --- | --- |
| 未終了（`requested` / `running`）の Research Request | `researcher` | Research Request |
| 最新 Evaluation が Direction Decision の根拠になっていない | `strategist` | Evaluation |
| Story、または Task の無い Outcome（未分解） | `manager` | Outcome |
| 全 Target Project から還流し `incomplete` が無く（`evaluability.status` が `evaluable`）、この Project の還流済み `executionCursor` で未評価。一部の Project の完了だけでは起動しない | `evaluator` | Outcome |
| 上記の無い Active Intent（進行中の Outcome・未終了の Research・判断待ちの Evaluation が無い。作成直後を含む） | `strategist` | Intent |

最新 Evaluation が判断済みの Outcome は進行中とみなしません。取消済み・archived Project は対象外です。Intent 作成時に Research Request は自動で作られず、Research の要否は起動された Strategist が判断します。

## 重複起動の抑止

起動対象は Project・対象・状態から決まる dispatch key を持ちます（例: `<projectId>:manager:outcome:<outcomeId>`。Intent の key は Outcome・Research の状態から求めた値を含み、状態が進むと変わります）。`stateDir` の `dispatches.json` に key ごとの起動記録を保存し、次の規則で起動します。

- 同じ `stateDir` で動く Orchestrator は1つだけ（`orchestrator.lock`）。2つ目は起動を拒否して終了する。停止したプロセスの lock は引き継ぐ
- 実行中（lease 内で、Orchestrator または起動した Agent のプロセスが生存）の key は起動しない。Orchestrator を再起動しても、動き続けている Agent を重複起動しない
- 成功（exit 0）した key は同じ状態で再起動しない。Agent が状態を変えずに終えた場合も同じ
- 失敗（exit 0 以外・timeout）は `retryBackoffMs × 2^(試行回数-1)` 待って `maxAttempts` まで再試行し、上限後は同じ状態で起動しない
- lease（`leaseMs`）を過ぎた Agent は process group ごと SIGTERM で停止させ、`terminateGraceMs` 後も残れば SIGKILL する。停止を確認してから失敗した試行として扱う
- Orchestrator が停止（SIGKILL 等）して Agent だけが残った場合も、lease を過ぎた後の周回で旧 Agent の停止を求め（猶予後は SIGKILL）、停止を確認するまで同じ key を起動しない。Orchestrator と Agent がともに停止した実行中の記録は、次の起動時に失敗した試行として回収する
- Agent の PID を記録するまで Role のコマンドを始めない。Agent の shell は fd 3 で Orchestrator の開始合図を待ち、合図の前に Orchestrator が停止すると（fd 3 が EOF）コマンドを実行せず終了する。spawn 後・PID 記録前に停止しても、PID の無い記録を回収して起動した次の試行と旧 Agent が同時に動かない
- 状態が進んで計画から消えた key の記録は捨てる

起動記録は重複抑止のためだけのもので、Compass の状態の正本ではありません。失っても現在状態から起動判断をやり直せます（その場合、実行中の Agent と重複し得ます）。`stateDir` を共有しない複数ホストでの並行実行は重複を抑止できません。Agent の Role 側の冪等性（同じ Evaluation への Decision は1件、同じ Outcome の Story は1件）は Server が強制します。

## 設定

設定は JSON file で渡します。token は値ではなく環境変数名を書きます。

```json
{
  "serverUrl": "http://127.0.0.1:51800",
  "stateDir": ".compass-orchestrator",
  "intervalMs": 60000,
  "leaseMs": 1800000,
  "maxAttempts": 3,
  "retryBackoffMs": 60000,
  "maxConcurrent": 2,
  "terminateGraceMs": 10000,
  "projects": [{ "projectId": "<projectId>", "tokenEnv": "COMPASS_ORCHESTRATOR_TOKEN" }],
  "roles": {
    "strategist": { "command": "claude -p \"$COMPASS_PROMPT\"", "env": {} },
    "researcher": { "command": "claude -p \"$COMPASS_PROMPT\"" },
    "manager": { "command": "claude -p \"$COMPASS_PROMPT\"" },
    "evaluator": { "command": "claude -p \"$COMPASS_PROMPT\"" }
  }
}
```

- `projects[].tokenEnv`: Server への Bearer を読む環境変数名。remote mode では Project の Administrator が Web UI で発行した Runtime Credential（scope `runtime:state:read`）、trusted-local では `runtime` Grant を持つ名前。Credential は Project ごとに発行する。Server へは常に `X-Compass-Active-Role: runtime` を送る
- `stateDir`: 設定 file からの相対 path。省略時は `.compass-orchestrator`
- `terminateGraceMs`: lease 切れの Agent を SIGTERM してから SIGKILL するまでの猶予。省略時は 10 秒
- `roles`: Role ごとの shell コマンド。書かなかった Role の対象は起動せず、記録もしない。Agent の Credential・MCP 設定は Role ごとの Principal で Agent 側に持たせる（`env` で設定 file の path 等を渡せる）。Orchestrator の token を Agent へ渡さない。Agent の環境変数からはすべての `projects[].tokenEnv` を除き、`roles.*.env` でそれらの名前を設定する構成は起動時に拒否する

起動する Agent には、Orchestrator の環境変数（Credential を除く）と `env` に加えて次の環境変数を渡します。

| 環境変数 | 内容 |
| --- | --- |
| `COMPASS_SERVER_URL` | Server の URL |
| `COMPASS_PROJECT_ID`・`COMPASS_ROLE` | 対象 Project と Role |
| `COMPASS_SUBJECT_KIND`・`COMPASS_SUBJECT_ID` | 対象（`intent` / `evaluation` / `research_request` / `outcome` と ID） |
| `COMPASS_DISPATCH_KEY`・`COMPASS_DISPATCH_ATTEMPT` | dispatch key と試行回数 |
| `COMPASS_PROMPT` | 上記と `get_role_context` の取得を指示する短い文。Role の手順は含めない |

## 実行・build・deploy

repo の root で `npm install` した後に実行します。

```bash
export COMPASS_ORCHESTRATOR_TOKEN="cmp_runtime.<id>.<secret>"
# 1周だけ実行し、起動した Agent の終了を待つ（cron 等の scheduler 向け）
npm run start --workspace orchestrator -- --config /path/to/orchestrator.json --once
# intervalMs ごとに繰り返す（SIGINT / SIGTERM で次の周回を止め、起動済みの Agent の終了を待つ）
npm run start --workspace orchestrator -- --config /path/to/orchestrator.json
```

`--config` の代わりに `COMPASS_ORCHESTRATOR_CONFIG` でも指定できます。Operational Log は JSON Lines で stderr に出し、Compass の Activity・Change Log には書きません。

`npm run build --workspace orchestrator` は型検査で、出力 file は作りません（Server と同じく `tsx` で実行します）。deploy 先に repo を置き、root で `npm ci` した後に上記コマンドを scheduler または process manager から起動します。`stateDir` は再起動後も残る場所に置きます。

## 検証

```bash
npm test --workspace orchestrator
npm run typecheck --workspace orchestrator
```

`tests/processRecovery.test.ts` は Orchestrator と Agent を実プロセスで起動し（Server は使わず固定状態）、Orchestrator を SIGKILL した後に残った Agent が lease を過ぎたら停止され（SIGTERM を無視する Agent は猶予後に SIGKILL）、停止を確認してから次の試行が起動されること、spawn 後・PID 記録前に Orchestrator を SIGKILL しても旧 Agent が Role のコマンドを実行せず次の試行だけが動くこと、Agent が Runtime Credential を読めないことを確認します。

`tests/integration.test.ts` は Server と Orchestrator を別プロセスで起動し（trusted-local・一時 DB・一時 cwd で、親の `COMPASS_*`・`PORT` を引き継がない）、並行起動・再起動・再試行の重複抑止と、Intent → Strategist → Researcher → Strategist → Manager の起動順を確認します。起動される Agent は決定的な fixture（`tests/support/fakeAgent.ts`）で、実 Agent による自律運転の実証ではありません。

## 未接続・未検証

- 実 Agent（Claude Code・Codex 等）を起動した運用は未検証
- Execution Evidence の還流（`record_execution_evidence`）は行わない。Evaluator の起動条件は還流済みの要約に依存する
- 複数ホストでの並行実行の重複抑止はない（`stateDir` を共有する1台を前提とする）
- 旧 Agent の生存は記録した PID の process group で判定する。Orchestrator の停止中に旧 Agent が終わり、同じ PID が別の process group leader に再利用された場合は、その group を旧 Agent とみなして停止し得る
- Windows では process group と開始合図を使わず、shell 経由で起動した孫プロセスの停止・生存確認と、PID 記録前に停止した場合の重複抑止は保証しない
