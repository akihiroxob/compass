# 現在の実装状況

ソースコードと公開入口に基づく現況。移行後の設計は [Architecture Handoff](../compass-codex-architecture-handoff.md) を参照する。

## 実装済み

| 領域 | 現在の構成・機能 |
| --- | --- |
| 起動 | npm workspaces。`server/`（`@compass/server`）がWeb UI（`server/src/web`、build出力`server/public/`）・`/api`・`/mcp`をHonoで同一portに提供。rootの`npm start`等はroot cwdのまま`server/`のentryを起動 |
| 構成 | `packages/direction`（`@compass/direction`）・`packages/work`（`@compass/work`）・`packages/access`（`@compass/access`。Principal・Role Grant・Credential・Membership・Human認証のuse case・規則）・`packages/activity`（`@compass/activity`。Activityのmodel・use case・保存）・`packages/shared`（`@compass/shared`。汎用errorと入力検証の部品）。transport（OIDC adapter・Cookie・Bearer解決）・DIは`server/src`にある。packageは`src/index.ts`で公開し、serverが配線する |
| 保存 | 単一SQLite file / Kysely。table型・DDLはDirection・Work・Access・Activityが各packageに持ち、serverの`Database`型と`initializeSchema`が合成する |
| Direction | Project・Intent・Outcome・固定成功条件・Research・Decision・Evaluation・ADR参照 |
| Execution | Story・Task・Claim・Comment・Change Log・Review・Acceptance |
| Human | Google OIDC・Web Session・Membership・招待・Web UIでの操作 |
| Agent | Credential・Project Role Grant・Git管理の`roles/`・`policies/`・`skills/`・`knowledge/`からのRole / Skill Context配信 |
| Activity | Project scopeのActivityの明示記録・参照（MCP）、Workの状態変更からのcanonical生成、Role Contextへのsummary接続、Web UIでの閲覧 |
| Runtime接続面 | event取得・ack、Execution Evidence還流、scope付きCredential |

Research Request / Result / Finding / SynthesisとDirection Decision・Evaluationは現在DBに保存する。Intent作成はInitial Research Requestを自動生成する。保存先は内容と所有責務で個別に判断し、Project別であることや本文が長いことを理由に一律移行しない。Strategistを最初に起動するフローへの変更は未実施。

現在のExecution Role名は`manager` / `worker` / `reviewer`で、統合後も維持する。

## Role / Skill Contextの現行契約

構成資産はrepo直下の`roles/<role>.md`（frontmatterの`skills`で使うSkillを参照）・`policies/role-policy.md`・`skills/<name>.md`（frontmatterに`requiredKnowledge`とnamespace付きの`requiredTools`。`allowRoles`は持たない）・`knowledge/`（Agent System共通知識）に置く。serverの`FileAgentAssetRepository`（infrastructure）がfileとGit revisionを読み、`AgentContextService` / `GetRoleContextUseCase`（`server/src/application/agentContext`）が配信する。

- `get_role_context({ projectId, role })`: 要求RoleのGrantが必要（activeRole指定時は同じRoleに限る）。Role Definition（frontmatterを除いた本文と`skills`）・共通Policy・参照SkillのmetadataとProject基本情報・Project Resources・最近のActivity（`activity`。`list_activities`と同じ形で新しい順に最大20件、summaryとrefsだけ）を返す。Skill本文・Knowledge本文・Activity本文は含めない。`unavailable`は空配列。`get_strategist_context`等のDirection集約は置き換えない
- `list_skills({ status?, role? })`・`get_skill_context({ name })`: 静的な手順書の取得でGrantは不要（remote modeの匿名呼出しには公開しない）。`role`は認可ではなくRole Definitionの参照による絞り込み
- 各応答の`source`は資産を読んだHEADの`revision`と、資産directoryの未commit変更の有無`dirty`（Git管理外はnull）
- 資産の欠落・形式不正（`allowRoles`・namespaceなしのTool・未知のSkill参照・knowledge外のpath）は部分応答を返さず`INSTRUCTION_UNAVAILABLE`。未知のSkillは`NOT_FOUND`
- `get_role_instructions`は互換のため残し、`policies/role-policy.md`（`includeShared`時に先頭）と`roles/<role>.md`をfileのまま返す

## Activityの現行契約

`packages/activity`がActivity（`activity` table）を所有する。追記専用で、更新・削除の経路は持たない。Change Log（Work）・Runtime event（Direction）・Operational Log（stdout）とは別のtableと契約で、Agentの実行単位（`runId`）は持たない。

- 項目: `id`・`cursor`（全体で単調増加）・`scope`（`project` / `system`。DBのCHECKでprojectIdの有無と整合させる）・`projectId`・`type`（`research.summary`等のdot区切り小文字）・`principalId`・`role`・`summary`（必須、500文字以内）・`body`（任意のMarkdown）・`refs`・`correctsActivityId`・`source`（`recorded` / `canonical`）・`occurredAt`・`recordedAt`。
- `refs`: `project_resource`（Projectに登録済みのRepository・Resourceの`resourceId`と任意の`path`・`revision`）・`url`（http(s)）・Entity（`intent`・`outcome`・`research_request`・`decision`・`story`・`task`・`activity`のid）。成果物の本文は持たない（未知の項目は拒否）。
- `record_activity`: PrincipalはBearerから、Roleは入力の`role`（そのRoleのGrantが必要）または`X-Compass-Active-Role`から決める。どちらも無ければ`VALIDATION_ERROR`、activeRoleと異なるRole・Grantの無いRoleは`FORBIDDEN`。archivedのProjectは`CONFLICT`。`runId`等の未知の項目は`VALIDATION_ERROR`。同じPrincipal・`requestId`の再送は同じActivity（`created: false`）を返し、別内容での再利用は`CONFLICT`。訂正は`correctsActivityId`を持つActivityを追記し、元は書き換えない。
- `list_activities` / `get_activity`: ProjectのいずれかのGrant（activeRole指定時はそのRole）が必要。一覧は本文を含めず`hasBody`を返す。`afterCursor`なしは新しい順で`nextCursor`を次の`beforeCursor`に、`afterCursor`ありは昇順の差分で`nextCursor`を次の`afterCursor`に使う。`principalId`・`role`・`type`・参照（`refKind` + `refId`）で絞り込める。`get_activity`は本文と、そのActivityを訂正したActivity（`corrections`）を返す。
- canonical生成: Workの`KyselyWorkStore`がChangeを追記した同じtransactionで、serverが配線した通知（`workChangeActivityObserver`）からActivityの`recordCanonicalWorkActivity`を呼ぶ。対象は`STORY_CREATED`・`STORY_COMPLETED`・`STORY_CANCELED`・`TASK_CREATED`・`TASK_COMPLETED`・`TASK_REVIEWED`・`TASK_ACCEPTED`・`TASK_REJECTED`・`TASK_CANCELED`で、Claim操作・編集・Story着手は対象外。`role`はChangeの`actorRole`（Human介入は`operator`）。生成元Changeの`cursor`で一意にするため重複せず、Activityを保存できなければ状態変更も確定しない。導入前のChange Logからは遡って生成しない。
- Human: Web API `GET /api/projects/:projectId/activities`（`beforeCursor`・`limit`）・`GET /api/projects/:projectId/activities/:activityId`はMembership（viewer以上）で認可し、Project詳細の「Activity」sectionで表示する。`project_resource`参照は登録済みのURLとpath・revisionで表示する。Web UIからは記録しない。

## Executionの現行契約

DirectionのProjectを共用し、Execution専用のProjectを複製しない。`packages/work`がStory / Task / Claim / Review / Acceptanceを所有する。状態遷移・Claimの排他と期限・自己レビュー / 自己受入の禁止はapplication層（`TaskCoordinationService`）が持ち、保存は`WorkStore` port（Kysely実装は`packages/work/src/infrastructure`）を通す。

Outcomeを参照するStoryは、成功条件・Constraints等の作成時snapshotと相関IDを持つ。相関IDとTaskの`taskKey`によって再送を同じ作業へ収束させる。Work側の受入をOutcome達成とは扱わない。

HumanはExecution一覧・Task詳細・最近の変更を参照でき、editor以上は手動起票・編集・受入・差戻し・取消・Commentを行える。Outcome handoffで管理するStory / TaskはHumanから編集できない。Story / Taskの編集（Web UI・MCPの`edit_story` / `edit_task`）は、内容が変わった場合だけ同じtransactionで`STORY_EDITED` / `TASK_EDITED`をChange Logへ追記し、`payload.changes`に変更前後を残す。MCPの同一`requestId`再送・失敗した編集では記録しない。編集は「最近の変更」とTask詳細の変更履歴に表示する。有効Claimとの競合を拒否し、取消後の古いClaim操作も拒否する。

DirectionとWorkは公開index（`@compass/direction`・`@compass/work`）とapplication portで接続し、DirectionはWorkに依存しない。WorkはProject状態・Role Grantを`WorkStore`の読取port（`ProjectStateReader`・`ProjectGrantReader`）で、Claim・状態遷移と同じtransactionの中で読む。実装はserverが配線し（`server/src/infrastructure/repository/contextAdapters.ts`）、Workは`project`・`project_grant`のtableを直接扱わない。Directionのuse caseが要求するRole・Runtime scopeの認可も、Directionのportへserverの認可serviceを渡す。境界は [executionBoundary.test.ts](../server/tests/executionBoundary.test.ts) で静的に検証する。Workの規則の単体テストは`packages/work/tests/`、Project集約の単体テストは`packages/direction/tests/`にある。

## Accessの現行契約

`packages/access`がAgentのRole Grant・Credential、HumanのMembership・招待・Session・ログイン試行を所有し、認可（`ProjectAuthorizationService`・`RuntimeAuthorizationService`・`HumanProjectAuthorizationService`）を提供する。Human Membership・Agent Grant・Runtime Credentialのscopeは別のモデル・tableで扱う。Claimの所有・期限・状態遷移・自己レビュー / 自己受入の禁止はWorkが強制し、Accessへ移さない。transport（OIDC adapter・Session Cookie・`Authorization`の解決）はserverの`server/src/auth`にある。

操作Contextの`activeRole`は、MCP・Runtime向けAPIのrequest header `X-Compass-Active-Role`で受け付ける（serverの`resolveActiveRole`）。headerがあれば、serverはrequestごとに`forActiveRole`で認可をそのRoleに固定したservice（Accessの`ProjectAuthorizationService`・Workの`TaskCoordinationService`と、それらで認可するDirection・Runtimeのuse case）を使い、`principalId + projectId + activeRole`のGrantだけで認可する。MCPのDirection参照・`list_projects`は、remote modeに加えtrusted-localでもactiveRole指定時はそのRoleのGrantを要求する（headerなしのtrusted-localは互換としてGrantを問わない）。Principalなしでの指定はProject scopeのtool（管理操作の`update_project`・Intent管理を含む）で`UNAUTHENTICATED`。trusted-localの`create_project`はProject作成前の操作でGrantの対象外のため、activeRoleの指定に関係なく実行できる。他Roleのtool・Grantの無いactiveRoleは`FORBIDDEN`。Accessが拒否する場合のうち、activeRoleと異なるRoleのtool、Project参照・管理操作でactiveRoleのGrantが無い場合は応答の`error.activeRole`にactiveRoleを返す（MCP・Runtime向けAPIとも`ForbiddenError`のdetailsを`error`へ展開する）。activeRoleと同じRoleのtoolでGrantが無い場合（`requiredRole`のみ）と、WorkのTask操作の拒否（`CoordinationError`）には含めない。未知の値は400。職務分離（Strategist等のGrantを持つPrincipalへの管理操作の拒否）は緩めない。headerなしは互換として操作ごとに必要Roleを検査し、拒否はRalph移行後に別途判断する。Runtime Credentialはheaderに関係なくscopeで認可する。`command_receipt.active_role`（nullable。既存行はNULL）に実行時のactiveRoleを保存し、同じ`principal_id + tool_name + request_id`を別のactiveRole（headerなしを含む）で再送すると`IDEMPOTENCY_CONFLICT`にする。自己レビュー・自己受入の禁止はPrincipal単位でWorkが強制し、Role切替では回避できない。Human向けWeb APIはMembershipで認可し、headerを読まない。

Accessは`project`のtableを直接読まない。archive判定・Projectの存在・owner不在Projectの補完に使うProject一覧は`ProjectStateReader` portで読み、Membership・Grant・Credentialの書込と同じtransactionで検査する。Project作成時の初期owner Membershipは、DirectionのProject作成のtransactionの中でAccessの`writeProjectOwnerMembership`が書く。いずれもserverが`contextAdapters.ts`で配線する。AccessがDirectionから使うのは公開indexのuse case（`GetProjectUseCase`・`ListProjectsUseCase`）・型・`ProjectArchivedError`だけで、DirectionはAccessに依存しない。

## 未実装・未接続・未検証

- `orchestrator/` / `ralph/`は未実施。
- `scope=system`のActivityは保存形式だけで、記録・参照の入口（MCP・Web）は無い。
- Directionの状態変更（Intent・Outcome・Research・Decision・Evaluation）からのcanonical Activity生成は未接続。現在のcanonical生成はWorkの状態変更だけ。
- Role / Skill Contextを実行時に取得するOrchestrator / Ralphは未接続。
- 本リポジトリには本番Orchestrator / Ralphの実装はない。Ralphの参照元は`/Users/aokayama/git/agent-foundation/ralph`。
- 実RuntimeによるAgent起動と継続したLv6自律運転は未接続・未検証。`server/tests/support/lv6Runtime.ts`等のfixtureを自律運転の実証としない。
- 実Googleとの接続確認は自動テストの対象外。

## 現在のRuntime API

`fetch_runtime_events` / `ack_runtime_event`は現在利用可能。eventの取得・ackにはconsumer単位のcursorと配送状態がある。`list_changes`はExecutionの変更を取得し、`record_execution_evidence`はサーバーが現在状態から導出した結果とEvidence参照をDirectionへ還流する。

これらは現在の接続契約である。確定したOrchestrator設計ではDirection / Workの現在状態で起動を判断し、Activity cursorをworkflow checkpointにしない。既存Runtime APIをActivityとして流用しない。
