# Compass Orchestrator

Workspace ごとに Compass Server の現在状態を読み、次に起動すべき専門 Role の Agent を起動する Batch Application です。Server とは独立して実行・build・deploy し、Server とは MCP（`/mcp`）だけで接続します。Server の DB・package は直接使いません。

## 責務

- 明示的な状態判定だけを行い、起動対象を決める（[`planWorkspaceDispatches`](src/plan.ts)）。どの Project が Outcome を担当するか・何を調査するか・Story / Task への分解などの知的判断は、起動された Role が行う
- 起動する Agent へは対象（Workspace ID、manager は Project ID・Role・対象 ID）だけを渡す。Role の手順・判断基準は渡さず、Agent が Role Context（Workspace Role は `get_workspace_role_context`、manager は `get_role_context`）で取得する
- 起動判断は毎回 Server の現在状態（`get_workspace_orchestration_state`）から行う。Activity・Runtime event の cursor を workflow checkpoint にしない
- Direction / Work の状態を書き換えない（読むだけ）。Worker / Reviewer の実行ループは Ralph の責務

## 起動規則

Server の `get_workspace_orchestration_state` の応答に対して次の規則で起動します（handoff v2「20」）。

| 現在状態 | 起動する Role | 対象 | dispatch key |
| --- | --- | --- | --- |
| 未終了（`requested` / `running`）の Research Request | `researcher` | Workspace・Research Request | `<workspaceId>:researcher:research_request:<id>` |
| 判断待ちの最新 Evaluation（Direction Decision の根拠になっていない） | `strategist` | Workspace・Evaluation | `<workspaceId>:strategist:evaluation:<id>` |
| 進行中の Outcome に Target が無い（`no_targets`） | `strategist` | Workspace・Outcome | `<workspaceId>:strategist:outcome:<id>:no_targets` |
| 進行中の Outcome の archived Target に未還流・`incomplete` が残る（`replan_required`）。他の active Target があっても起動する | `strategist` | Workspace・Outcome | `<workspaceId>:strategist:outcome:<id>:replan:<Target構成と未完了Targetの版>` |
| 進行中の Outcome の active Target で、その Project に Story、または Task が無い | `manager` | Target Project・Outcome | `<workspaceId>:<projectId>:manager:outcome:<id>` |
| 全 Target から還流し `incomplete` が無く（`evaluable`。archive 前に還流を終えた Target を含む）、最新 Evaluation の Project 別 cursor と一致しない。一部の Project の完了だけでは起動しない | `evaluator` | Workspace・Outcome | `<workspaceId>:evaluator:outcome:<id>:<Project別cursorの版>` |
| 上記の無い Active Intent（進行中の Outcome・未終了の Research・判断待ちの Evaluation が無い。作成直後を含む） | `strategist` | Workspace・Intent | `<workspaceId>:strategist:intent:<id>:<状態の版>` |

最新 Evaluation が判断済みの Outcome は進行中とみなしません。archived の Workspace では何も起動せず、archived Project の manager は起動しません。Intent 作成時に Research Request は自動で作られず、Research の要否は起動された Strategist が判断します。どの Project を Target にするか、Target の解除・再割当・Outcome の見直し、Story の分割は起動された Role が判断し、Orchestrator は推論しません。同じ状態からは同じ key になり、再計画で状態が変われば新しい key になります。

## 重複起動の抑止

起動対象は Workspace・Project・対象・状態から決まる dispatch key を持ちます（上表。Intent の key は Outcome・Research の状態から求めた値を含み、状態が進むと変わります）。`stateDir` の `dispatches.json` に key ごとの起動記録を保存し、次の規則で起動します。

- 同じ `stateDir` で動く Orchestrator は1つだけ（`orchestrator.lock`）。2つ目は起動を拒否して終了する。停止したプロセスの lock は引き継ぐ
- 実行中（lease 内で、Orchestrator または起動した Agent のプロセスが生存）の key は起動しない。Orchestrator を再起動しても、動き続けている Agent を重複起動しない
- 成功（exit 0）した key は同じ状態で再起動しない。Agent が状態を変えずに終えた場合も同じ
- 失敗（exit 0 以外・timeout）は `retryBackoffMs × 2^(試行回数-1)` 待って `maxAttempts` まで再試行し、上限後は同じ状態で起動しない
- lease（`leaseMs`）を過ぎた Agent は process group ごと SIGTERM で停止させ、`terminateGraceMs` 後も残れば SIGKILL する。停止を確認してから失敗した試行として扱う
- Orchestrator が停止（SIGKILL 等）して Agent だけが残った場合も、lease を過ぎた後の周回で旧 Agent の停止を求め（猶予後は SIGKILL）、停止を確認するまで同じ key を起動しない。Orchestrator と Agent がともに停止した実行中の記録は、次の起動時に失敗した試行として回収する
- Agent の PID を記録するまで Role のコマンドを始めない。Agent の shell は fd 3 で Orchestrator の開始合図を待ち、合図の前に Orchestrator が停止すると（fd 3 が EOF）コマンドを実行せず終了する。spawn 後・PID 記録前に停止しても、PID の無い記録を回収して起動した次の試行と旧 Agent が同時に動かない
- 状態が進んで計画から消えた key の記録は Workspace ごとに捨てる（状態を読めなかった Workspace の記録は残す）

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
  "workspaces": [
    {
      "workspaceId": "<workspaceId>",
      "tokenEnv": "COMPASS_ORCHESTRATOR_TOKEN",
      "agentEnv": { "AGENT_MCP_CONFIG": "/etc/compass/<workspaceId>-direction.mcp.json" },
      "projects": [
        { "projectId": "<projectIdA>", "agentEnv": { "AGENT_MCP_CONFIG": "/etc/compass/<projectIdA>-manager.mcp.json" } },
        { "projectId": "<projectIdB>", "agentEnv": { "AGENT_MCP_CONFIG": "/etc/compass/<projectIdB>-manager.mcp.json" } }
      ]
    }
  ],
  "roles": {
    "strategist": { "command": "claude -p \"$COMPASS_PROMPT\" --mcp-config \"$AGENT_MCP_CONFIG\"", "env": {} },
    "researcher": { "command": "claude -p \"$COMPASS_PROMPT\" --mcp-config \"$AGENT_MCP_CONFIG\"" },
    "manager": { "command": "claude -p \"$COMPASS_PROMPT\" --mcp-config \"$AGENT_MCP_CONFIG\"" },
    "evaluator": { "command": "claude -p \"$COMPASS_PROMPT\" --mcp-config \"$AGENT_MCP_CONFIG\"" }
  }
}
```

- `workspaces[].tokenEnv`: Server への Bearer を読む環境変数名。Workspace の Administrator が発行した Workspace Runtime Credential（scope `runtime:state:read`）を入れる。Project Runtime Credential と trusted-local の `Bearer <RuntimeName>` は `get_workspace_orchestration_state` で拒否される。Server へは常に `X-Compass-Active-Role: runtime` を送る
- `workspaces[].agentEnv`: Workspace Role（strategist / researcher / evaluator）の Agent へ加える環境変数。Workspace Agent Credential（Workspace Role Grant を持つ Principal）を使う MCP 設定 file の path 等を渡す
- `workspaces[].projects[]`: manager を起動する Project と、その manager の Agent へ加える `agentEnv`（その Project の Agent Credential を使う設定）。ここに無い Target Project の manager は起動せず、記録もしない（Workspace の `agentEnv` で代用しない）。Workspace・Project はそれぞれ設定全体で1回だけ書ける
- `stateDir`: 設定 file からの相対 path。省略時は `.compass-orchestrator`
- `terminateGraceMs`: lease 切れの Agent を SIGTERM してから SIGKILL するまでの猶予。省略時は 10 秒
- `roles`: Role ごとの shell コマンド。書かなかった Role の対象は起動せず、記録もしない。Agent へは `roles.<role>.env` に scope の `agentEnv` を重ねて渡す
- Orchestrator の token を Agent へ渡さない。Agent の環境変数からはすべての `workspaces[].tokenEnv` を除き、`roles.*.env`・`agentEnv` でそれらの名前を設定する構成は起動時に拒否する。未知の項目も拒否する

Agent Credential の値を設定 file に直接書かず、Agent 側の MCP 設定 file（権限を絞った場所）に置き、`agentEnv` ではその path を渡すことを推奨します。

起動する Agent には、Orchestrator の環境変数（Credential と下表の名前を除く）、`roles.<role>.env` と scope の `agentEnv` に加えて次の環境変数を渡します。

| 環境変数 | 内容 |
| --- | --- |
| `COMPASS_SERVER_URL` | Server の URL |
| `COMPASS_WORKSPACE_ID` | 対象 Workspace |
| `COMPASS_PROJECT_ID` | manager の対象 Project。Workspace Role には渡さない |
| `COMPASS_ROLE` | Role |
| `COMPASS_SUBJECT_KIND`・`COMPASS_SUBJECT_ID` | 対象（`intent` / `evaluation` / `research_request` / `outcome` と ID） |
| `COMPASS_DISPATCH_KEY`・`COMPASS_DISPATCH_ATTEMPT` | dispatch key と試行回数 |
| `COMPASS_PROMPT` | 上記と Role Context の取得（Workspace Role は `get_workspace_role_context({ workspaceId, role })`、manager は `get_role_context({ projectId, role })`）を指示する短い文。Role の手順は含めない |

### Project 単位の設定からの移行

Project 単位の設定（`projects[]`）は読み込みを拒否し、移行手順を示して終了します。次の順で書き換えます。

1. 動いている Orchestrator を停止する（SIGINT / SIGTERM。起動済み Agent の終了を待つ）
2. 各 Project の所属 Workspace を確認する（`get_project` の `workspaceId`、または Web UI）。同じ Workspace の Project は1つの `workspaces[]` 要素にまとめる
3. Workspace の Administrator が Workspace Runtime Credential（scope `runtime:state:read`）を発行し（`POST /api/workspaces/:workspaceId/credentials`）、`tokenEnv` の環境変数へ入れる。Project Runtime Credential は使えない
4. Workspace Role の Agent が使う Workspace Agent Credential を発行し、`workspaces[].agentEnv` から参照させる。manager の Agent が使う Project Agent Credential は Project ごとに `workspaces[].projects[].agentEnv` から参照させる
5. 同じ `stateDir` で起動する。Project 基準の起動記録（`dispatches.json` の version 1。key が Project ID で始まる）は引き継がず捨てる。その Agent がまだ動いている間は起動を拒否するので、終了を待つか停止してから起動し直す

## 実行・build・deploy

repo の root で `npm install` した後に実行します。

```bash
# Workspace Runtime Credential（scope runtime:state:read）
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

`tests/integration.test.ts` は Server と Orchestrator を別プロセスで起動し（trusted-local・一時 DB・一時 cwd で、親の `COMPASS_*`・`PORT` を引き継がない）、Web API で発行した Workspace Runtime Credential で状態を読み、Workspace Role の Agent は Workspace Agent Credential、Target Project A / B の manager はそれぞれの Project Agent Credential で操作することを確認します。並行起動・再起動・再試行の重複抑止、Intent → Strategist → Researcher → Strategist → Manager（A・B）の起動順、Project 単位の設定の拒否と Workspace 単位の設定への移行（旧起動記録を引き継がない）も確認します。同じ Workspace へ2つ目の Project を作る公開入口と Workspace Role Grant の付与入口が未接続のため、その2点は一時 DB への fixture です。起動される Agent は決定的な fixture（`tests/support/fakeAgent.ts`）で、実 Agent による自律運転の実証ではありません。

## 未接続・未検証

- 実 Agent（Claude Code・Codex 等）を起動した運用は未検証。上の設定例の `--mcp-config` による Credential の受け渡しも未検証
- Workspace Runtime / Agent Credential を発行する Web UI は無く、Web API（`/api/workspaces/:workspaceId/credentials`）で発行する
- Execution Evidence の還流（`record_execution_evidence`）は行わない。Evaluator の起動条件は還流済みの要約に依存する
- 複数ホストでの並行実行の重複抑止はない（`stateDir` を共有する1台を前提とする）
- 旧 Agent の生存は記録した PID の process group で判定する。Orchestrator の停止中に旧 Agent が終わり、同じ PID が別の process group leader に再利用された場合は、その group を旧 Agent とみなして停止し得る
- Windows では process group と開始合図を使わず、shell 経由で起動した孫プロセスの停止・生存確認と、PID 記録前に停止した場合の重複抑止は保証しない
