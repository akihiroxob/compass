# 現在の実装状況

ソースコードと公開入口に基づく現況。移行後の設計は [Architecture Handoff](../compass-codex-architecture-handoff.md) を参照する。

## 実装済み

| 領域 | 現在の構成・機能 |
| --- | --- |
| 起動 | npm workspaces。`server/`（`@compass/server`）がWeb UI（`server/src/web`、build出力`server/public/`）・`/api`・`/mcp`をHonoで同一portに提供。rootの`npm start`等はroot cwdのまま`server/`のentryを起動 |
| 構成 | `packages/direction`（`@compass/direction`）・`packages/work`（`@compass/work`）・`packages/access`（`@compass/access`。Principal・Role Grant・Credential・Membership・Human認証のuse case・規則）・`packages/shared`（`@compass/shared`。汎用errorと入力検証の部品）。transport（OIDC adapter・Cookie・Bearer解決）・DIは`server/src`にある。packageは`src/index.ts`で公開し、serverが配線する |
| 保存 | 単一SQLite file / Kysely。table型・DDLはDirection・Work・Accessが各packageに持ち、serverの`Database`型と`initializeSchema`が合成する |
| Direction | Project・Intent・Outcome・固定成功条件・Research・Decision・Evaluation・ADR参照 |
| Execution | Story・Task・Claim・Comment・Change Log・Review・Acceptance |
| Human | Google OIDC・Web Session・Membership・招待・Web UIでの操作 |
| Agent | Credential・Project Role Grant・`agent/`からのInstruction配信 |
| Runtime接続面 | event取得・ack、Execution Evidence還流、scope付きCredential |

Research Request / Result / Finding / SynthesisとDirection Decision・Evaluationは現在DBに保存する。Intent作成はInitial Research Requestを自動生成する。保存先は内容と所有責務で個別に判断し、Project別であることや本文が長いことを理由に一律移行しない。Strategistを最初に起動するフローへの変更は未実施。

現在のExecution Role名は`manager` / `worker` / `reviewer`で、統合後も維持する。`get_role_context` / `get_skill_context`は未実装。`get_role_instructions`は現在利用できる。

## Executionの現行契約

DirectionのProjectを共用し、Execution専用のProjectを複製しない。`packages/work`がStory / Task / Claim / Review / Acceptanceを所有する。状態遷移・Claimの排他と期限・自己レビュー / 自己受入の禁止はapplication層（`TaskCoordinationService`）が持ち、保存は`WorkStore` port（Kysely実装は`packages/work/src/infrastructure`）を通す。

Outcomeを参照するStoryは、成功条件・Constraints等の作成時snapshotと相関IDを持つ。相関IDとTaskの`taskKey`によって再送を同じ作業へ収束させる。Work側の受入をOutcome達成とは扱わない。

HumanはExecution一覧・Task詳細・最近の変更を参照でき、editor以上は手動起票・編集・受入・差戻し・取消・Commentを行える。Outcome handoffで管理するStory / TaskはHumanから編集できない。Story / Taskの編集（Web UI・MCPの`edit_story` / `edit_task`）は、内容が変わった場合だけ同じtransactionで`STORY_EDITED` / `TASK_EDITED`をChange Logへ追記し、`payload.changes`に変更前後を残す。MCPの同一`requestId`再送・失敗した編集では記録しない。編集は「最近の変更」とTask詳細の変更履歴に表示する。有効Claimとの競合を拒否し、取消後の古いClaim操作も拒否する。

DirectionとWorkは公開index（`@compass/direction`・`@compass/work`）とapplication portで接続し、DirectionはWorkに依存しない。WorkはProject状態・Role Grantを`WorkStore`の読取port（`ProjectStateReader`・`ProjectGrantReader`）で、Claim・状態遷移と同じtransactionの中で読む。実装はserverが配線し（`server/src/infrastructure/repository/contextAdapters.ts`）、Workは`project`・`project_grant`のtableを直接扱わない。Directionのuse caseが要求するRole・Runtime scopeの認可も、Directionのportへserverの認可serviceを渡す。境界は [executionBoundary.test.ts](../server/tests/executionBoundary.test.ts) で静的に検証する。Workの規則の単体テストは`packages/work/tests/`、Project集約の単体テストは`packages/direction/tests/`にある。

## Accessの現行契約

`packages/access`がAgentのRole Grant・Credential、HumanのMembership・招待・Session・ログイン試行を所有し、認可（`ProjectAuthorizationService`・`RuntimeAuthorizationService`・`HumanProjectAuthorizationService`）を提供する。Human Membership・Agent Grant・Runtime Credentialのscopeは別のモデル・tableで扱う。Claimの所有・期限・状態遷移・自己レビュー / 自己受入の禁止はWorkが強制し、Accessへ移さない。transport（OIDC adapter・Session Cookie・`Authorization`の解決）はserverの`server/src/auth`にある。

操作Contextの`activeRole`は、MCP・Runtime向けAPIのrequest header `X-Compass-Active-Role`で受け付ける（serverの`resolveActiveRole`）。headerがあれば、serverはrequestごとに`forActiveRole`で認可をそのRoleに固定したservice（Accessの`ProjectAuthorizationService`・Workの`TaskCoordinationService`と、それらで認可するDirection・Runtimeのuse case）を使い、`principalId + projectId + activeRole`のGrantだけで認可する。MCPのDirection参照・`list_projects`は、remote modeに加えtrusted-localでもactiveRole指定時はそのRoleのGrantを要求する（headerなしのtrusted-localは互換としてGrantを問わない）。他Roleのtool・Grantの無いactiveRoleは`FORBIDDEN`（`activeRole`を応答に含む）、未知の値は400。職務分離（Strategist等のGrantを持つPrincipalへの管理操作の拒否）は緩めない。headerなしは互換として操作ごとに必要Roleを検査し、拒否はRalph移行後に別途判断する。Runtime Credentialはheaderに関係なくscopeで認可する。`command_receipt.active_role`（nullable。既存行はNULL）に実行時のactiveRoleを保存し、同じ`principal_id + tool_name + request_id`を別のactiveRole（headerなしを含む）で再送すると`IDEMPOTENCY_CONFLICT`にする。自己レビュー・自己受入の禁止はPrincipal単位でWorkが強制し、Role切替では回避できない。Human向けWeb APIはMembershipで認可し、headerを読まない。

Accessは`project`のtableを直接読まない。archive判定・Projectの存在・owner不在Projectの補完に使うProject一覧は`ProjectStateReader` portで読み、Membership・Grant・Credentialの書込と同じtransactionで検査する。Project作成時の初期owner Membershipは、DirectionのProject作成のtransactionの中でAccessの`writeProjectOwnerMembership`が書く。いずれもserverが`contextAdapters.ts`で配線する。AccessがDirectionから使うのは公開indexのuse case（`GetProjectUseCase`・`ListProjectsUseCase`）・型・`ProjectArchivedError`だけで、DirectionはAccessに依存しない。

## 未実装・未接続・未検証

- `packages/activity`への分離、`orchestrator/` / `ralph/`は未実施。
- 独立したActivity package・DB、Role / Skill / KnowledgeのJIT Context配信は未実装。
- 本リポジトリには本番Orchestrator / Ralphの実装はない。Ralphの参照元は`/Users/aokayama/git/agent-foundation/ralph`。
- 実RuntimeによるAgent起動と継続したLv6自律運転は未接続・未検証。`server/tests/support/lv6Runtime.ts`等のfixtureを自律運転の実証としない。
- 実Googleとの接続確認は自動テストの対象外。

## 現在のRuntime API

`fetch_runtime_events` / `ack_runtime_event`は現在利用可能。eventの取得・ackにはconsumer単位のcursorと配送状態がある。`list_changes`はExecutionの変更を取得し、`record_execution_evidence`はサーバーが現在状態から導出した結果とEvidence参照をDirectionへ還流する。

これらは現在の接続契約である。確定したOrchestrator設計ではDirection / Workの現在状態で起動を判断し、Activity cursorをworkflow checkpointにしない。既存Runtime APIをActivityとして流用しない。
