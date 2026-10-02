# 現在の実装状況

ソースコードと公開入口に基づく現況。移行後の設計は [Architecture Handoff](../compass-codex-architecture-handoff.md) を参照する。

## 実装済み

| 領域 | 現在の構成・機能 |
| --- | --- |
| 起動 | 単一npm package。HonoがWeb UI・`/api`・`/mcp`を同一portで提供 |
| 保存 | SQLite / Kysely。`initializeSchema`によるschema初期化 |
| Direction | Project・Intent・Outcome・固定成功条件・Research・Decision・Evaluation・ADR参照 |
| Execution | Story・Task・Claim・Comment・Change Log・Review・Acceptance |
| Human | Google OIDC・Web Session・Membership・招待・Web UIでの操作 |
| Agent | Credential・Project Role Grant・`agent/`からのInstruction配信 |
| Runtime接続面 | event取得・ack、Execution Evidence還流、scope付きCredential |

Research Request / Result / Finding / SynthesisとDirection Decision・Evaluationは現在DBに保存する。Intent作成はInitial Research Requestを自動生成する。保存先は内容と所有責務で個別に判断し、Project別であることや本文が長いことを理由に一律移行しない。Strategistを最初に起動するフローへの変更は未実施。

現在のExecution Role名は`manager` / `worker` / `reviewer`で、統合後も維持する。操作Contextの明示的な`activeRole`、`get_role_context` / `get_skill_context`は未実装。`get_role_instructions`は現在利用できる。

## Executionの現行契約

DirectionのProjectを共用し、Execution専用のProjectを複製しない。`src/domain/model/execution`、`src/application/service/execution`、`src/infrastructure/repository/execution`等で責務を分ける。

Outcomeを参照するStoryは、成功条件・Constraints等の作成時snapshotと相関IDを持つ。相関IDとTaskの`taskKey`によって再送を同じ作業へ収束させる。Work側の受入をOutcome達成とは扱わない。

HumanはExecution一覧・Task詳細・最近の変更を参照でき、editor以上は手動起票・編集・受入・差戻し・取消・Commentを行える。Outcome handoffで管理するStory / TaskはHumanから編集できない。有効Claimとの競合を拒否し、取消後の古いClaim操作も拒否する。

DirectionとExecutionはapplication portで接続する。現在の境界検証では共通の`project`・`project_grant`を例外として扱う（[executionBoundary.test.ts](../test/executionBoundary.test.ts)）。

## 未実装・未接続・未検証

- `server/` / `orchestrator/` / `ralph/`と`packages/`への構造移行は未実施。
- 独立したActivity package・DB、Role / Skill / KnowledgeのJIT Context配信は未実装。
- 本リポジトリには本番Orchestrator / Ralphの実装はない。Ralphの参照元は`/Users/aokayama/git/agent-foundation/ralph`。
- 実RuntimeによるAgent起動と継続したLv6自律運転は未接続・未検証。`test/support/lv6Runtime.ts`等のfixtureを自律運転の実証としない。
- 実Googleとの接続確認は自動テストの対象外。

## 現在のRuntime API

`fetch_runtime_events` / `ack_runtime_event`は現在利用可能。eventの取得・ackにはconsumer単位のcursorと配送状態がある。`list_changes`はExecutionの変更を取得し、`record_execution_evidence`はサーバーが現在状態から導出した結果とEvidence参照をDirectionへ還流する。

これらは現在の接続契約である。確定したOrchestrator設計ではDirection / Workの現在状態で起動を判断し、Activity cursorをworkflow checkpointにしない。既存Runtime APIをActivityとして流用しない。
