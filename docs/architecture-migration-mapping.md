# 構造移行マッピング

[移行計画](architecture-migration-plan.md)のTask 01で確定した、現行コードから[統合設計](../compass-codex-architecture-handoff.md)への対応・依存違反・互換性契約・移行単位。Task 02以降はこの文書を前提に着手する。記載は移行先の定義であり、移行の完了を意味しない。

調査対象はCompass `4f6bd70`、Wacha `86fc281`、Shirube `647381c`、agent-foundation `e2d954c`。

## 参照元の取り込み状況

| 参照元 | Compassへ取り込み済み | 未取り込み・移行Task |
| --- | --- | --- |
| Wacha | Story / Task / Claim / Comment / Change Log / command receipt（`TaskCoordinationService`）、Project Role Grant、`agent/`のRole文書配信、Hono・Vite・SQLite・Kysely構成 | `skill/`・`knowledge/`、`FileSkillRepository`・`FileKnowledgeRepository`、`list_skills`・`get_skill_context`（06）。Skillの`allowRoles`は移植時に除去する |
| Shirube | Project・Vision・Outcome・Research・Decision・Evidence相当（Direction） | `manager-runner`（lease型のManager起動）は08で現在状態Queryとして再設計し、移植しない。Improvement系・Artifact relationは今回のStory範囲外で移植しない |
| agent-foundation | なし | `ralph/`（bash: `bin/ralph`・`bin/ralph-loop`・`backends/wacha.sh`・`providers/`・`prompts/`）を09で移す。`prompts/*.md`のRole手順はRole Contextで取得し、Ralphへ複製しない |

## 確定した扱い

| 項目 | 移行中の扱い | 理由 |
| --- | --- | --- |
| Goal / Vision | `project.vision`のfield・column・API名を変更しない。Direction packageでも`Vision`の名称のまま移す。`Goal`は導入しない | 概念図の`Goal`と`Vision`の同一性は未合意。改名は製品判断として[設計確認事項](planning/architecture-questions.md)に残す |
| evaluator | Role・Grant・`get_evaluator_context` / `record_outcome_evaluation`を維持し、`roles/evaluator.md`へ移す。Outcome Evaluationは`packages/direction`が所有する | 初期Role候補にないことは廃止の合意ではない |
| runtime Role | trusted-local開発用Roleとして維持し、`roles/runtime.md`へ移す。存続は08 / 09で判断する | remote modeではRuntime Credentialのscopeで認可しており、Runtime APIの互換を壊さない |
| package manager | npm workspacesを使う。`package-lock.json`を維持し、pnpmへ移行しない。root `npm start` / `npm test` / `npm run typecheck` / `npm run build`は名前と意味を保ったままworkspaceへ委譲する | 推奨Treeのpnpm構成は構成例であり、技術変更を自動採用しない。npm workspacesで独立build・実行の要件を満たせる |
| activeRole transport | MCPとRuntime向けAPIで、request header `X-Compass-Active-Role`を受け付ける。MCPはrequestごとにstatelessで、`Authorization`と同じ`resolveCaller`の段階で解決する。Tool入力・Credentialには持たせない | 現行の`resolveCaller`が1 requestの`Authorization`だけで主体を確定する構造に、最小変更で追加できる。Credentialへ固定すると1 Principalの複数Grantから実行ごとに1 Roleを選べない |
| activeRole互換期間 | 05ではheaderなしを従来どおり「操作ごとに必要Roleを検査」で受け付け、headerがあれば`principalId + projectId + activeRole`のGrantだけで認可する（他Grantを合算しない）。Ralph・Orchestrator接続（08 / 09）はheaderを必須で送る。headerなしの拒否はRalph移行後の別判断とする | 稼働中の開発支援Wacha・既存Ralphの接続を05で壊さない |
| `manager` → `work-manager` | 05で`project_grant.role`の`manager`を`work-manager`へ移行するDB migrationを`initializeSchema`内で冪等に行う。互換期間中は入力・headerの`manager`を`work-manager`の別名として受け付け、応答・保存は`work-manager`にする | 既存Grantを失わず、旧名で接続するAgentを即時に失効させない |
| command receipt | 05で`command_receipt`へnullableの`active_role`を追加する。同じ`principal_id + tool_name + request_id`を異なるactiveRoleで再送した場合は既存結果を返さず`CONFLICT`にする。既存行は`NULL`のまま保持する | 冪等性の再送でRole制約を回避させない |
| DB | 単一SQLite file・`COMPASS_DB_PATH`・既存table名を維持する。移行で既存tableを削除しない。table定義（`schema.ts`）と`initializeSchema`は02でserverへ移し、03 / 04で所有packageごとに分割しserverが合成する | 既存データの保持と戻し方を単純にする |

## 責務が曖昧なコード

| ID | 対象 | 判断 |
| --- | --- | --- |
| A1 | `RuntimeEvent`・`runtime_event*` table・`fetch_runtime_events` / `ack_runtime_event` | Direction状態変更と同一transactionで生成するため`packages/direction`へ置く。Activityとして流用しない。08で現在状態Queryへ切り替えた後も公開APIは互換対象とし、廃止は別判断 |
| A2 | `OutcomeExecution`・`record_execution_evidence`・`get_outcome_execution_summary` | Directionが所有するEvidence還流。Work側の結果は`ExecutionSummaryPort`（Directionが要求、Workが実装）で取得する |
| A3 | `outcomeCorrelation.ts`（`outcome:{outcomeId}`） | Direction→Workの公開契約。`packages/direction`の`index.ts`からexportし、Workはこれだけを参照する |
| A4 | `HumanProjectUseCases`（Project操作とMembershipの合成） | Access側に置き、Directionへはuse case経由で依存する。Direction repositoryを直接使わない形へ04で変更する |
| A5 | `GetStrategistContext` / `GetResearcherContext` / `GetEvaluatorContext` | Direction情報の集約としてDirectionへ置く。06の`get_role_context`はこれらを置換せず、Role・Policy・Skill metadataと並べて返す |
| A6 | `InstructionService`・`get_role_instructions` | serverのMCP配信へ置く。module相対pathで`agent/`を読むため、02で移動する時はpathを修正する。06で`get_role_context`を追加し、`get_role_instructions`は互換期間中残す |
| A7 | `application/error/*` | 汎用エラー（Validation / NotFound / Conflict / Forbidden / Unauthenticated）だけ`packages/shared/src/errors/`へ。業務固有エラーは所有packageへ |
| A8 | `shared/*Schema.ts`（zod入力schema） | 業務入力の検証なので所有packageのapplication層へ移す。`packages/shared`へは置かない |
| A9 | frontendが`domain/model`（`HumanAuth`・`OutcomeEvaluation`・`OutcomeExecution`）を型importしている | 02ではpathだけ追随し、03 / 04で各packageの公開型（`index.ts`）経由に変える |

## 依存方向違反

| ID | 違反 | 是正Task |
| --- | --- | --- |
| V1 | `application/service/execution/TaskCoordinationService.ts`・`ExecutionSummaryService.ts`がKyselyと`infrastructure/database/schema.ts`へ依存（application→infrastructure） | 03でWorkのrepository / unit of work portを定義し、Kysely実装を`packages/work/src/infrastructure`へ移す |
| V2 | `TaskCoordinationService`がDirectionの`project`（archive判定）とAccessの`project_grant`を直接SQLで参照 | 03でDirectionのProject状態port、04でAccessの認可portへ置換。Claim操作と同一transactionが必要な検査は、portの実装をserverで同じDB transactionに束ねる |
| V3 | `domain/repository/*Repository.ts`・`InitialResearchRequest.ts`が`shared/*Schema.ts`（zod定義）の型へ依存 | 03 / 04でschemaをapplicationへ移す際に、domainはplainな入力型を持つ |
| V4 | `domain/model/ProjectGrant.ts`・`domain/repository/ProjectGrantRepository.ts`が`constants/ProjectRole.ts`へ依存 | 04で`ProjectRole`を`packages/access/src/domain`へ移し解消 |
| V5 | Access repository（`SQLiteHumanAccountRepository`・`SQLiteProjectGrantRepository`・`SQLiteProjectMembershipRepository`・`SQLiteAccessCredentialRepository`）がDirectionの`project`をSQL参照（`isProjectArchived`含む）。逆に`SQLiteProjectRepository`がAccessの`project_membership`へ書込む | 04でDirectionのProject状態port・AccessのMembership作成portへ置換。Project作成と初期owner Membershipの原子性は同一transactionで維持する |
| V6 | `InstructionService`（application）が`node:fs`で読む | 06でfile読込をinfrastructure adapterへ移す |
| V7 | `executionBoundary.test.ts`が`project`・`project_grant`を共通tableの例外として許可 | 03 / 04の是正に合わせて例外を外し、package間のDB直接操作がないことを検査する |

Domain層はReact・Hono・MCP SDK・Kyselyを直接importしていない（V3はzodの型経由の間接依存）。

## 互換性契約

移行中に次を変更しない。変更が必要な場合はTaskで互換期間と移行手順を設計する。

- 起動: rootでの`npm install`・`npm start`（Web UI build後にserver起動）・`npm run dev`・`npm run cli`。既定port `51800`。
- 同一portの`/`（Web UI）・`/api`・`/mcp`・`/health`・`/auth/*`。
- 環境変数: `PORT`・`COMPASS_DB_PATH`・`COMPASS_HOST`・`COMPASS_AUTH_MODE`・`COMPASS_PUBLIC_ORIGIN`・`COMPASS_GOOGLE_CLIENT_ID`・`COMPASS_GOOGLE_CLIENT_SECRET`・`COMPASS_INITIAL_OWNER_EMAIL`・`COMPASS_REGISTRATION_MODE`・`COMPASS_CLAIM_TTL_MS`。起動ディレクトリの`.env`読込。
- HTTP API: `app.ts`・`registerHumanAuthRoutes.ts`のroute・status・error形式（`{ error: { code, message } }`）。
- MCP: `createMcpServer.ts`の33 tool（`get_role_instructions`を含む）・`registerExecutionTools.ts`の21 toolの名前・入力・`structuredContent`・error形式（`CoordinationError`の`retryable`を含む）。remote modeの匿名呼出しは`get_role_instructions`だけ。
- 認証: `Authorization: Bearer <AgentName>`（trusted-localのみ）、`cmp_` Credential、Human Session Cookie。
- DB: 既存table・column・SQLite file。Grantの`manager`は05の移行まで現行値。
- Role文書: `get_role_instructions`の`role`・`includeShared`と`agent/role-policy.md`を先頭に返す応答。

## 最小移行単位と検証・戻し方

各Taskは1 commit以上の小さな単位で行い、各commitで下記の回帰検証を通す。戻し方は該当commitの`git revert`を基本とし、DB変更を伴うTaskは移行前DBの複製で再実行できることを確認する。

| Task | 最小移行単位 | 回帰検証 | 戻し方 |
| --- | --- | --- | --- |
| 02 | (1) root npm workspaces化と`server/`へのsrc・frontend・test移動を`git mv`で行い、import pathだけ修正 (2) build出力`public/`・静的配信path・`agent/`読込pathの修正 | 全テスト、`typecheck`、`build`、`npm start`で`/health`・`/api`・`/mcp`・Web UIを同一portで確認 | revert。DB変更なし |
| 03 | Direction→Workの順に、domain→application→infrastructureを1 packageずつ移し、serverで配線 | 上記に加え`executionCoordination`・`executionHandoff`・`executionMcp`・`executionBoundary`（V7更新後） | revert。DB変更なし |
| 04 | `ProjectRole`・Grant・Credential・Membership・Human認証のuse caseを`packages/access`へ。transport（OIDC・Cookie・Bearer解決）はserverに残す | 上記に加え`humanAuth*`・`humanWebAuthorization`・`accessCredential`・`projectGrant*`・`remoteMcpHumanCommands` | revert。DB変更なし |
| 05 | activeRole header・Grant検査、`work-manager`移行、`command_receipt.active_role` | 複数Grantの合算拒否、headerなし互換、旧名alias、自己レビュー・自己受入禁止、receipt再送 | revert＋移行前DB複製へ戻す。`work-manager`→`manager`の逆変換手順をTaskで用意する |
| 06 | `agent/`→`roles/`・`policies/`、Wachaの`skill/`・`knowledge/`を`skills/`・`knowledge/`へ移し`allowRoles`を除去、`get_role_context` / `get_skill_context` | `instruction`テスト、Role→Skillの一方向参照、Git revision | revert。DB変更なし |
| 07 | `packages/activity`のtable・use case・Role Context接続 | Activityの冪等性・認可・cursor | revert。追加tableは残しても既存機能に影響しない |
| 08 | `orchestrator/`の独立package・現在状態Query | 重複起動抑止、既存Research Requestの保持 | revert |
| 09 | `ralph/`へagent-foundationのRalphを移しCompassへ接続 | 別Principal・別Credential、Claim期限・停止・再開 | revert。稼働中のWacha・既存Ralphは置換しない |

### 現在の検証基準

Task 01時点（コード変更なし）の結果。移行後もこれより悪化させない。

- `npm run typecheck`・`npm run build`: 成功。
- `npm test`: 382件中379件成功、3件失敗。失敗は`test/lv6ClosedLoop.test.ts`の3件（`src/server.ts`を子プロセスで起動）で、起動ディレクトリの`.env`（`4f6bd70`で読込を追加）がテストの環境変数を補完することが原因。`.env`のない`4f6bd70`のworktreeでは3件とも成功する。起動テストの`.env`・既存port隔離は10の受入条件だる。02以降の回帰判定は`.env`のない環境で行うか、先に隔離する。

## ファイル対応表

`git ls-files`と未追跡の`src/`・`test/`・`agent/`の全285 fileを対象とする。テストは全件がserverの合成（`app.ts`・`createApplicationServices.ts`等）をimportするため02で`server/tests/`へ移し、package単体で実行できるテストは03 / 04で各`packages/*/tests/`へ分ける。移行先が`/`で終わるものは同名fileを置く。

### frontend

`src/frontend/**`（69 files）→ `server/src/web/**`。相対構造を維持し、`vite.config.ts`・`tsconfig.json`のpathとbuild出力先（現在`public/`）を同時に更新する。

### src

| 現在 | 移行先 | 備考 |
| --- | --- | --- |
| `src/app.ts` | `server/src/bootstrap/app.ts` | app.tsのAPI routeは同Taskでserver/src/api/へ分割可 |
| `src/application/error/ConflictError.ts` | `packages/shared/src/errors/` | 業務概念を含まない汎用エラーのみ |
| `src/application/error/CoordinationError.ts` | `packages/work/src/application/error/` |  |
| `src/application/error/ForbiddenError.ts` | `packages/shared/src/errors/` | 業務概念を含まない汎用エラーのみ |
| `src/application/error/InstructionUnavailableError.ts` | server/src/mcp/（06でRole Context配信へ置換） |  |
| `src/application/error/LastOwnerError.ts` | `packages/access/src/application/error/` |  |
| `src/application/error/NotFoundError.ts` | `packages/shared/src/errors/` | 業務概念を含まない汎用エラーのみ |
| `src/application/error/ProjectArchivedError.ts` | `packages/direction/src/application/error/` |  |
| `src/application/error/UnauthenticatedError.ts` | `packages/shared/src/errors/` | 業務概念を含まない汎用エラーのみ |
| `src/application/error/ValidationError.ts` | `packages/shared/src/errors/` | 業務概念を含まない汎用エラーのみ |
| `src/application/port/DirectionReferenceLookupPort.ts` | `packages/work/src/application/port/` | Workが要求するport |
| `src/application/port/ExecutionSummaryPort.ts` | `packages/direction/src/application/port/` | Directionが要求するport |
| `src/application/port/HumanIdentityProvider.ts` | `packages/access/src/application/port/` |  |
| `src/application/service/DirectionReferenceLookupService.ts` | `packages/direction/src/application/` | Workのportを満たす実装。serverで配線 |
| `src/application/service/HumanProjectAuthorizationService.ts` | `packages/access/src/application/HumanProjectAuthorizationService.ts` |  |
| `src/application/service/InstructionService.ts` | server/src/mcp/（06でRole Context use caseへ置換） | module相対pathでagent/を読む |
| `src/application/service/ProjectAuthorizationService.ts` | `packages/access/src/application/ProjectAuthorizationService.ts` |  |
| `src/application/service/RuntimeAuthorizationService.ts` | `packages/access/src/application/RuntimeAuthorizationService.ts` |  |
| `src/application/service/execution/ExecutionOperatorUseCases.ts` | `packages/work/src/application/ExecutionOperatorUseCases.ts` | Kysely依存をinfrastructureへ分離 |
| `src/application/service/execution/ExecutionReadUseCases.ts` | `packages/work/src/application/ExecutionReadUseCases.ts` | Kysely依存をinfrastructureへ分離 |
| `src/application/service/execution/ExecutionSummaryService.ts` | `packages/work/src/application/ExecutionSummaryService.ts` | Kysely依存をinfrastructureへ分離 |
| `src/application/service/execution/TaskCoordinationService.ts` | `packages/work/src/application/TaskCoordinationService.ts` | Kysely依存をinfrastructureへ分離 |
| `src/application/service/secretToken.ts` | `packages/access/src/application/secretToken.ts` |  |
| `src/application/usecase/AbandonIntentUseCase.ts` | `packages/direction/src/application/AbandonIntentUseCase.ts` |  |
| `src/application/usecase/AccessCredentialUseCases.ts` | `packages/access/src/application/AccessCredentialUseCases.ts` |  |
| `src/application/usecase/AckRuntimeEventUseCase.ts` | `packages/direction/src/application/AckRuntimeEventUseCase.ts` |  |
| `src/application/usecase/ArchiveProjectUseCase.ts` | `packages/direction/src/application/ArchiveProjectUseCase.ts` |  |
| `src/application/usecase/CancelOutcomeUseCase.ts` | `packages/direction/src/application/CancelOutcomeUseCase.ts` |  |
| `src/application/usecase/CloseResearchRequestUseCases.ts` | `packages/direction/src/application/CloseResearchRequestUseCases.ts` |  |
| `src/application/usecase/CreateAdrHandoffRequestUseCase.ts` | `packages/direction/src/application/CreateAdrHandoffRequestUseCase.ts` |  |
| `src/application/usecase/CreateDirectionDecisionUseCase.ts` | `packages/direction/src/application/CreateDirectionDecisionUseCase.ts` |  |
| `src/application/usecase/CreateIntentUseCase.ts` | `packages/direction/src/application/CreateIntentUseCase.ts` |  |
| `src/application/usecase/CreateOutcomeUseCase.ts` | `packages/direction/src/application/CreateOutcomeUseCase.ts` |  |
| `src/application/usecase/CreateProjectUseCase.ts` | `packages/direction/src/application/CreateProjectUseCase.ts` |  |
| `src/application/usecase/CreateResearchRequestUseCase.ts` | `packages/direction/src/application/CreateResearchRequestUseCase.ts` |  |
| `src/application/usecase/DecideNextOutcomeUseCase.ts` | `packages/direction/src/application/DecideNextOutcomeUseCase.ts` |  |
| `src/application/usecase/FetchRuntimeEventsUseCase.ts` | `packages/direction/src/application/FetchRuntimeEventsUseCase.ts` |  |
| `src/application/usecase/GetEvaluatorContextUseCase.ts` | `packages/direction/src/application/GetEvaluatorContextUseCase.ts` |  |
| `src/application/usecase/GetExecutionSummaryUseCase.ts` | `packages/direction/src/application/GetExecutionSummaryUseCase.ts` |  |
| `src/application/usecase/GetIntentUseCase.ts` | `packages/direction/src/application/GetIntentUseCase.ts` |  |
| `src/application/usecase/GetOutcomeUseCase.ts` | `packages/direction/src/application/GetOutcomeUseCase.ts` |  |
| `src/application/usecase/GetProjectUseCase.ts` | `packages/direction/src/application/GetProjectUseCase.ts` |  |
| `src/application/usecase/GetResearchRequestUseCase.ts` | `packages/direction/src/application/GetResearchRequestUseCase.ts` |  |
| `src/application/usecase/GetResearcherContextUseCase.ts` | `packages/direction/src/application/GetResearcherContextUseCase.ts` |  |
| `src/application/usecase/GetStrategistContextUseCase.ts` | `packages/direction/src/application/GetStrategistContextUseCase.ts` |  |
| `src/application/usecase/GrantProjectRoleUseCase.ts` | `packages/access/src/application/GrantProjectRoleUseCase.ts` |  |
| `src/application/usecase/HumanLoginUseCases.ts` | `packages/access/src/application/HumanLoginUseCases.ts` |  |
| `src/application/usecase/HumanProjectUseCases.ts` | `packages/access/src/application/HumanProjectUseCases.ts` |  |
| `src/application/usecase/HumanSessionUseCases.ts` | `packages/access/src/application/HumanSessionUseCases.ts` |  |
| `src/application/usecase/ListAdrReferencesUseCase.ts` | `packages/direction/src/application/ListAdrReferencesUseCase.ts` |  |
| `src/application/usecase/ListDirectionDecisionsUseCase.ts` | `packages/direction/src/application/ListDirectionDecisionsUseCase.ts` |  |
| `src/application/usecase/ListIntentsUseCase.ts` | `packages/direction/src/application/ListIntentsUseCase.ts` |  |
| `src/application/usecase/ListOutcomeEvaluationsUseCase.ts` | `packages/direction/src/application/ListOutcomeEvaluationsUseCase.ts` |  |
| `src/application/usecase/ListOutcomesUseCase.ts` | `packages/direction/src/application/ListOutcomesUseCase.ts` |  |
| `src/application/usecase/ListProjectGrantsUseCase.ts` | `packages/access/src/application/ListProjectGrantsUseCase.ts` |  |
| `src/application/usecase/ListProjectsUseCase.ts` | `packages/direction/src/application/ListProjectsUseCase.ts` |  |
| `src/application/usecase/ListResearchRequestsUseCase.ts` | `packages/direction/src/application/ListResearchRequestsUseCase.ts` |  |
| `src/application/usecase/ListRuntimeEventsUseCase.ts` | `packages/direction/src/application/ListRuntimeEventsUseCase.ts` |  |
| `src/application/usecase/ProjectMembershipUseCases.ts` | `packages/access/src/application/ProjectMembershipUseCases.ts` |  |
| `src/application/usecase/RecordAdrReferenceUseCase.ts` | `packages/direction/src/application/RecordAdrReferenceUseCase.ts` |  |
| `src/application/usecase/RecordExecutionEvidenceUseCase.ts` | `packages/direction/src/application/RecordExecutionEvidenceUseCase.ts` |  |
| `src/application/usecase/RecordOutcomeEvaluationUseCase.ts` | `packages/direction/src/application/RecordOutcomeEvaluationUseCase.ts` |  |
| `src/application/usecase/RegisterResearchResultUseCase.ts` | `packages/direction/src/application/RegisterResearchResultUseCase.ts` |  |
| `src/application/usecase/RegisterResearchSynthesisUseCase.ts` | `packages/direction/src/application/RegisterResearchSynthesisUseCase.ts` |  |
| `src/application/usecase/RevokeProjectRoleUseCase.ts` | `packages/access/src/application/RevokeProjectRoleUseCase.ts` |  |
| `src/application/usecase/UpdateIntentUseCase.ts` | `packages/direction/src/application/UpdateIntentUseCase.ts` |  |
| `src/application/usecase/UpdateOutcomeUseCase.ts` | `packages/direction/src/application/UpdateOutcomeUseCase.ts` |  |
| `src/application/usecase/UpdateProjectUseCase.ts` | `packages/direction/src/application/UpdateProjectUseCase.ts` |  |
| `src/application/usecase/adrHandoffRejection.ts` | `packages/direction/src/application/adrHandoffRejection.ts` |  |
| `src/application/usecase/directionDecisionRejection.ts` | `packages/direction/src/application/directionDecisionRejection.ts` |  |
| `src/application/usecase/researchRejection.ts` | `packages/direction/src/application/researchRejection.ts` |  |
| `src/constants/ProjectRole.ts` | `packages/access/src/domain/ProjectRole.ts` | 05でwork-manager・activeRoleへ |
| `src/container.ts` | `server/src/bootstrap/container.ts` | app.tsのAPI routeは同Taskでserver/src/api/へ分割可 |
| `src/createApplicationServices.ts` | `server/src/bootstrap/createApplicationServices.ts` | app.tsのAPI routeは同Taskでserver/src/api/へ分割可 |
| `src/domain/model/AccessCredential.ts` | `packages/access/src/domain/AccessCredential.ts` |  |
| `src/domain/model/AdditionalResearchRequest.ts` | `packages/direction/src/domain/AdditionalResearchRequest.ts` |  |
| `src/domain/model/AdrHandoff.ts` | `packages/direction/src/domain/AdrHandoff.ts` |  |
| `src/domain/model/DirectionDecision.ts` | `packages/direction/src/domain/DirectionDecision.ts` |  |
| `src/domain/model/HumanAuth.ts` | `packages/access/src/domain/HumanAuth.ts` |  |
| `src/domain/model/InitialResearchRequest.ts` | `packages/direction/src/domain/InitialResearchRequest.ts` |  |
| `src/domain/model/Intent.ts` | `packages/direction/src/domain/Intent.ts` |  |
| `src/domain/model/Outcome.ts` | `packages/direction/src/domain/Outcome.ts` |  |
| `src/domain/model/OutcomeEvaluation.ts` | `packages/direction/src/domain/OutcomeEvaluation.ts` |  |
| `src/domain/model/OutcomeExecution.ts` | `packages/direction/src/domain/OutcomeExecution.ts` |  |
| `src/domain/model/Project.ts` | `packages/direction/src/domain/Project.ts` |  |
| `src/domain/model/ProjectGrant.ts` | `packages/access/src/domain/ProjectGrant.ts` |  |
| `src/domain/model/Research.ts` | `packages/direction/src/domain/Research.ts` |  |
| `src/domain/model/RuntimeEvent.ts` | `packages/direction/src/domain/RuntimeEvent.ts` |  |
| `src/domain/model/RuntimeEventDelivery.ts` | `packages/direction/src/domain/RuntimeEventDelivery.ts` |  |
| `src/domain/model/execution/StoryStatus.ts` | `packages/work/src/domain/StoryStatus.ts` |  |
| `src/domain/model/execution/TaskStatus.ts` | `packages/work/src/domain/TaskStatus.ts` |  |
| `src/domain/repository/AccessCredentialRepository.ts` | `packages/access/src/domain/AccessCredentialRepository.ts` |  |
| `src/domain/repository/AdrHandoffRepository.ts` | `packages/direction/src/domain/AdrHandoffRepository.ts` |  |
| `src/domain/repository/DirectionDecisionRepository.ts` | `packages/direction/src/domain/DirectionDecisionRepository.ts` |  |
| `src/domain/repository/HumanAccountRepository.ts` | `packages/access/src/domain/HumanAccountRepository.ts` |  |
| `src/domain/repository/IntentRepository.ts` | `packages/direction/src/domain/IntentRepository.ts` |  |
| `src/domain/repository/LoginAttemptRepository.ts` | `packages/access/src/domain/LoginAttemptRepository.ts` |  |
| `src/domain/repository/OutcomeEvaluationRepository.ts` | `packages/direction/src/domain/OutcomeEvaluationRepository.ts` |  |
| `src/domain/repository/OutcomeExecutionRepository.ts` | `packages/direction/src/domain/OutcomeExecutionRepository.ts` |  |
| `src/domain/repository/OutcomeRepository.ts` | `packages/direction/src/domain/OutcomeRepository.ts` |  |
| `src/domain/repository/ProjectGrantRepository.ts` | `packages/access/src/domain/ProjectGrantRepository.ts` |  |
| `src/domain/repository/ProjectMembershipRepository.ts` | `packages/access/src/domain/ProjectMembershipRepository.ts` |  |
| `src/domain/repository/ProjectRepository.ts` | `packages/direction/src/domain/ProjectRepository.ts` |  |
| `src/domain/repository/ResearchRepository.ts` | `packages/direction/src/domain/ResearchRepository.ts` |  |
| `src/domain/repository/RuntimeEventRepository.ts` | `packages/direction/src/domain/RuntimeEventRepository.ts` |  |
| `src/infrastructure/database/createDatabase.ts` | `server/src/bootstrap/database/` | 02で移動 |
| `src/infrastructure/database/initializeSchema.ts` | server/src/bootstrap/database/initializeSchema.ts（02）→ 各package infrastructureへtable定義を分割（03/04） | 単一SQLite fileを維持 |
| `src/infrastructure/database/schema.ts` | server/src/bootstrap/database/schema.ts（02）→ 各package infrastructureへtable定義を分割（03/04） | 単一SQLite fileを維持 |
| `src/infrastructure/identity/GoogleOidcIdentityProvider.ts` | `server/src/auth/GoogleOidcIdentityProvider.ts` | HumanIdentityProvider portのadapter |
| `src/infrastructure/repository/SQLiteAccessCredentialRepository.ts` | `packages/access/src/infrastructure/SQLiteAccessCredentialRepository.ts` |  |
| `src/infrastructure/repository/SQLiteAdrHandoffRepository.ts` | `packages/direction/src/infrastructure/SQLiteAdrHandoffRepository.ts` |  |
| `src/infrastructure/repository/SQLiteDirectionDecisionRepository.ts` | `packages/direction/src/infrastructure/SQLiteDirectionDecisionRepository.ts` |  |
| `src/infrastructure/repository/SQLiteHumanAccountRepository.ts` | `packages/access/src/infrastructure/SQLiteHumanAccountRepository.ts` |  |
| `src/infrastructure/repository/SQLiteIntentRepository.ts` | `packages/direction/src/infrastructure/SQLiteIntentRepository.ts` |  |
| `src/infrastructure/repository/SQLiteLoginAttemptRepository.ts` | `packages/access/src/infrastructure/SQLiteLoginAttemptRepository.ts` |  |
| `src/infrastructure/repository/SQLiteOutcomeEvaluationRepository.ts` | `packages/direction/src/infrastructure/SQLiteOutcomeEvaluationRepository.ts` |  |
| `src/infrastructure/repository/SQLiteOutcomeExecutionRepository.ts` | `packages/direction/src/infrastructure/SQLiteOutcomeExecutionRepository.ts` |  |
| `src/infrastructure/repository/SQLiteOutcomeRepository.ts` | `packages/direction/src/infrastructure/SQLiteOutcomeRepository.ts` |  |
| `src/infrastructure/repository/SQLiteProjectGrantRepository.ts` | `packages/access/src/infrastructure/SQLiteProjectGrantRepository.ts` |  |
| `src/infrastructure/repository/SQLiteProjectMembershipRepository.ts` | `packages/access/src/infrastructure/SQLiteProjectMembershipRepository.ts` |  |
| `src/infrastructure/repository/SQLiteProjectRepository.ts` | `packages/direction/src/infrastructure/SQLiteProjectRepository.ts` |  |
| `src/infrastructure/repository/SQLiteResearchRepository.ts` | `packages/direction/src/infrastructure/SQLiteResearchRepository.ts` |  |
| `src/infrastructure/repository/SQLiteRuntimeEventRepository.ts` | `packages/direction/src/infrastructure/SQLiteRuntimeEventRepository.ts` |  |
| `src/infrastructure/repository/adrHandoffRecord.ts` | `packages/direction/src/infrastructure/adrHandoffRecord.ts` |  |
| `src/infrastructure/repository/directionDecisionRecord.ts` | `packages/direction/src/infrastructure/directionDecisionRecord.ts` |  |
| `src/infrastructure/repository/humanAuthRecord.ts` | `packages/access/src/infrastructure/humanAuthRecord.ts` |  |
| `src/infrastructure/repository/initialResearchRequest.ts` | `packages/direction/src/infrastructure/initialResearchRequest.ts` |  |
| `src/infrastructure/repository/inputHash.ts` | `packages/shared/src/` | 冪等性のhash。Direction・Accessが利用 |
| `src/infrastructure/repository/isProjectArchived.ts` | `packages/direction/src/infrastructure/` | Access repositoryの直接参照はportへ置換（V5） |
| `src/infrastructure/repository/outcomeRecord.ts` | `packages/direction/src/infrastructure/outcomeRecord.ts` |  |
| `src/infrastructure/repository/researchRequestRecord.ts` | `packages/direction/src/infrastructure/researchRequestRecord.ts` |  |
| `src/infrastructure/repository/runtimeEventRecord.ts` | `packages/direction/src/infrastructure/runtimeEventRecord.ts` |  |
| `src/presentation/cli/main.ts` | `server/src/cli/main.ts` | 保守用途 |
| `src/presentation/cli/runCli.ts` | `server/src/cli/runCli.ts` | 保守用途 |
| `src/presentation/http/humanAuthConfig.ts` | `server/src/auth/humanAuthConfig.ts` |  |
| `src/presentation/http/registerHumanAuthRoutes.ts` | `server/src/auth/registerHumanAuthRoutes.ts` |  |
| `src/presentation/mcp/createMcpServer.ts` | `server/src/mcp/createMcpServer.ts` |  |
| `src/presentation/mcp/registerExecutionTools.ts` | `server/src/mcp/registerExecutionTools.ts` |  |
| `src/presentation/mcp/resolvePrincipal.ts` | `server/src/auth/resolvePrincipal.ts` | transport認証 |
| `src/presentation/mcp/toolExecution.ts` | `server/src/mcp/toolExecution.ts` |  |
| `src/server.ts` | `server/src/main.ts` |  |
| `src/shared/adrHandoffSchema.ts` | `packages/direction/src/application/adrHandoffSchema.ts` |  |
| `src/shared/credentialSchema.ts` | `packages/access/src/application/credentialSchema.ts` |  |
| `src/shared/directionDecisionSchema.ts` | `packages/direction/src/application/directionDecisionSchema.ts` |  |
| `src/shared/executionEvidenceSchema.ts` | `packages/direction/src/application/executionEvidenceSchema.ts` |  |
| `src/shared/executionOperatorSchema.ts` | `packages/work/src/application/` |  |
| `src/shared/humanAuthSchema.ts` | `packages/access/src/application/humanAuthSchema.ts` |  |
| `src/shared/intentSchema.ts` | `packages/direction/src/application/intentSchema.ts` |  |
| `src/shared/outcomeCorrelation.ts` | packages/direction/src/（公開契約としてindex.tsからexport） | Workが参照 |
| `src/shared/outcomeEvaluationSchema.ts` | `packages/direction/src/application/outcomeEvaluationSchema.ts` |  |
| `src/shared/outcomeSchema.ts` | `packages/direction/src/application/outcomeSchema.ts` |  |
| `src/shared/projectGrantSchema.ts` | `packages/access/src/application/projectGrantSchema.ts` |  |
| `src/shared/projectSchema.ts` | `packages/direction/src/application/projectSchema.ts` |  |
| `src/shared/researchSchema.ts` | `packages/direction/src/application/researchSchema.ts` |  |
| `src/shared/runtimeEventSchema.ts` | `packages/direction/src/application/runtimeEventSchema.ts` |  |

### agent

| 現在 | 移行先 | 備考 |
| --- | --- | --- |
| `agent/evaluator.md` | `roles/evaluator.md` |  |
| `agent/manager.md` | `roles/work-manager.md` | Task 05/06で改名。互換期間は旧名を残す |
| `agent/researcher.md` | `roles/researcher.md` |  |
| `agent/reviewer.md` | `roles/reviewer.md` |  |
| `agent/role-policy.md` | `policies/role-policy.md` |  |
| `agent/runtime.md` | roles/runtime.md（要判断） | 開発用trusted-local Role。08/09で存続を判断 |
| `agent/strategist.md` | `roles/strategist.md` |  |
| `agent/worker.md` | `roles/worker.md` |  |

### test

| 現在 | 移行先 | 備考 |
| --- | --- | --- |
| `test/accessCredential.test.ts` | `server/tests/accessCredential.test.ts` | 主対象: access |
| `test/additionalResearch.test.ts` | `server/tests/additionalResearch.test.ts` | 主対象: direction |
| `test/adrHandoff.test.ts` | `server/tests/adrHandoff.test.ts` | 主対象: direction |
| `test/app.test.ts` | `server/tests/app.test.ts` | 主対象: server |
| `test/credentialUi.test.ts` | `server/tests/credentialUi.test.ts` | 主対象: access |
| `test/directionDecision.test.ts` | `server/tests/directionDecision.test.ts` | 主対象: direction |
| `test/evaluationReplan.test.ts` | `server/tests/evaluationReplan.test.ts` | 主対象: direction |
| `test/executionBoundary.test.ts` | `server/tests/executionBoundary.test.ts` | 主対象: work。03で境界検証を更新 |
| `test/executionCoordination.test.ts` | `server/tests/executionCoordination.test.ts` | 主対象: work |
| `test/executionEvidence.test.ts` | `server/tests/executionEvidence.test.ts` | 主対象: direction |
| `test/executionHandoff.test.ts` | `server/tests/executionHandoff.test.ts` | 主対象: work |
| `test/executionMcp.test.ts` | `server/tests/executionMcp.test.ts` | 主対象: work |
| `test/executionOperator.test.ts` | `server/tests/executionOperator.test.ts` | 主対象: work |
| `test/executionPlan.test.ts` | `server/tests/executionPlan.test.ts` | 主対象: work |
| `test/executionUi.test.ts` | `server/tests/executionUi.test.ts` | 主対象: work |
| `test/executionWebRead.test.ts` | `server/tests/executionWebRead.test.ts` | 主対象: work |
| `test/frontendApi.test.ts` | `server/tests/frontendApi.test.ts` | 主対象: server |
| `test/grantForm.test.ts` | `server/tests/grantForm.test.ts` | 主対象: access |
| `test/humanAuth.test.ts` | `server/tests/humanAuth.test.ts` | 主対象: access |
| `test/humanAuthHttpIntegration.test.ts` | `server/tests/humanAuthHttpIntegration.test.ts` | 主対象: access |
| `test/humanOidc.test.ts` | `server/tests/humanOidc.test.ts` | 主対象: access |
| `test/humanWebAuthorization.test.ts` | `server/tests/humanWebAuthorization.test.ts` | 主対象: access |
| `test/initialResearch.test.ts` | `server/tests/initialResearch.test.ts` | 主対象: direction |
| `test/instruction.test.ts` | `server/tests/instruction.test.ts` | 主対象: server。06でRole Context検証へ |
| `test/intent.test.ts` | `server/tests/intent.test.ts` | 主対象: direction |
| `test/intentAdapters.test.ts` | `server/tests/intentAdapters.test.ts` | 主対象: direction |
| `test/intentBrief.test.ts` | `server/tests/intentBrief.test.ts` | 主対象: direction |
| `test/intentForm.test.ts` | `server/tests/intentForm.test.ts` | 主対象: direction |
| `test/lv6ClosedLoop.test.ts` | `server/tests/lv6ClosedLoop.test.ts` | 主対象: server |
| `test/membershipUi.test.ts` | `server/tests/membershipUi.test.ts` | 主対象: access |
| `test/outcome.test.ts` | `server/tests/outcome.test.ts` | 主対象: direction |
| `test/outcomeAdapters.test.ts` | `server/tests/outcomeAdapters.test.ts` | 主対象: direction |
| `test/outcomeConfirmed.test.ts` | `server/tests/outcomeConfirmed.test.ts` | 主対象: direction |
| `test/outcomeEvaluation.test.ts` | `server/tests/outcomeEvaluation.test.ts` | 主対象: direction |
| `test/outcomeForm.test.ts` | `server/tests/outcomeForm.test.ts` | 主対象: direction |
| `test/project.test.ts` | `server/tests/project.test.ts` | 主対象: direction |
| `test/projectAdapters.test.ts` | `server/tests/projectAdapters.test.ts` | 主対象: direction |
| `test/projectArchive.test.ts` | `server/tests/projectArchive.test.ts` | 主対象: direction |
| `test/projectArchiveUi.test.ts` | `server/tests/projectArchiveUi.test.ts` | 主対象: direction |
| `test/projectForm.test.ts` | `server/tests/projectForm.test.ts` | 主対象: direction |
| `test/projectGrant.test.ts` | `server/tests/projectGrant.test.ts` | 主対象: access |
| `test/projectGrantAdapters.test.ts` | `server/tests/projectGrantAdapters.test.ts` | 主対象: access |
| `test/remoteMcpHumanCommands.test.ts` | `server/tests/remoteMcpHumanCommands.test.ts` | 主対象: access |
| `test/research.test.ts` | `server/tests/research.test.ts` | 主対象: direction |
| `test/researchDecisionIntegration.test.ts` | `server/tests/researchDecisionIntegration.test.ts` | 主対象: direction |
| `test/researcherMcp.test.ts` | `server/tests/researcherMcp.test.ts` | 主対象: direction |
| `test/runtimeEvents.test.ts` | `server/tests/runtimeEvents.test.ts` | 主対象: direction |
| `test/strategistIntegration.test.ts` | `server/tests/strategistIntegration.test.ts` | 主対象: direction |
| `test/strategistMcp.test.ts` | `server/tests/strategistMcp.test.ts` | 主対象: direction |
| `test/support/humanSession.ts` | `server/tests/support/humanSession.ts` | 主対象: - |
| `test/support/lv6Runtime.ts` | `server/tests/support/lv6Runtime.ts` | 主対象: -。fixtureであり実自律運転ではない |
| `test/support/oidcFixture.ts` | `server/tests/support/oidcFixture.ts` | 主対象: - |
| `test/updateProject.test.ts` | `server/tests/updateProject.test.ts` | 主対象: direction |
