# Lv6統合設計：Direction・Execution境界とMCP統合方針

## 位置づけ

この文書はStory「Lv6：統一MCPでDirection→Execution→Evaluationの閉ループを実接続する」の最初のTask（Task 30）の成果物である。後続Task 31〜38が前提とする構造上の決定を記録する。**設計のみを対象とし、コード移植・DB変更・UI変更は含まない**。実装は各Taskで個別に行う。

優先順位はAGENTS.mdの方針に従う: ユーザーの最新指示 > kit/additional-doc.md（特に「2. システム全体の基本構造」「3. Agent/System/Runtimeの責任分離」「23〜29. Wachaの責務とShirube/Wachaの境界」「34. Codexへの最重要指示」）> 既存Compass実装（Step1〜4、Task23〜29の実装記録）> その他kit文書。kit/additional-doc.mdの「32. 未解決事項」「33. 次にやること」にある事項は草案として扱い、確定要件にしない。

参照: AGENTS.md、kit/additional-doc.md、docs/research-decision-adr-design.md、`/Users/aokayama/git/wacha`（既存コード・テスト・Instruction文書の一次資料）。

## 用語の混同に対する注記（重要）

本Taskを割り当てている稼働中のWacha MCPサーバー（`baseDir: /Users/aokayama/git/compass`, `projectName: compass`）は、Compassというソフトウェアを開発するための **開発支援ツール** であり、移植対象ではない。このWachaインスタンスのProject／Task／Claimには一切触れない。

移植対象は `/Users/aokayama/git/wacha` のソースコードが実装する **Execution Loop Management** の概念そのもの（Story / Task / Claim / Comment / Change Log、manager / worker / reviewer）である。これをCompass製品自身に組み込み、Compass製品が自身のOutcomeから生じるRepository作業を、Compass製品のHuman・Agentに対して提供できるようにする。移植後にCompass自身の開発（本Ralph Loopなど）が移植後のExecutionへ乗り換えるかどうかは本Storyの対象外。

## 全体決定（要約）

1. **Project概念は統合し、複製しない**。旧WachaのProjectはCompassの既存`project`テーブルへ一本化する。旧Wachaの`project`／`project_grant`テーブルは移植しない。旧WachaのbaseDir（ローカルfilesystemパス）概念も移植しない。
2. **ProjectRoleを拡張する**。既存の`strategist`/`researcher`に`manager`/`worker`/`reviewer`を追加し、既存の`project_grant`テーブル・`GrantProjectRoleUseCase`系・`ProjectAuthorizationService`・Web UIのGrant画面パターンをそのまま再利用する（Task 24が`researcher`追加時に確認済みの通り、`role`列はcheck制約が無くスキーマ変更不要）。旧Wachaの独自Grant機構は移植しない。
3. **Execution固有のEntity（Story/Task/Claim/Comment/Change Log/Command Receipt）だけを新規テーブルとして移植する**。すべて既存の`project.id`をスコープに使う。
4. **DirectionのEntity（Outcome、Direction Decision、Project.constraints等）をExecution側へ複製しない**。StoryはOutcome/Decisionを参照（ID + 作成時snapshot）として持つのみで、Execution側のRepository/SQLite tableはDirection側のtableを直接読み書きしない。逆方向も同様。
5. **単一npmパッケージ・単一Honoサーバー・単一`/mcp`を維持する**。kit/additional-doc.md §28のapps/packages monorepo案は「まだ最終決定ではない」草案であり、現在のCompassが単一パッケージのflat構成であることを踏まえ、今回は不要な大規模リファクタリングを避け、`src/domain/model`等の既存ディレクトリ内でDirection/Executionをサブディレクトリ分離する小さい選択を採る（詳細は「モジュール構成」）。
6. **MCP tool名はWachaの既存名をそのまま移植する**。衝突する`list_projects`のみ移植を見送り、既存Compassの`list_projects`（Direction Project一覧）に一本化する。`get_role_instructions`は新規tool化せず、既存toolのrole enum拡張で対応する。
7. **Runtime向けイベントは既存`runtime_event`（Direction）と新規`change_log`（Execution）の2系統を維持する**。用途が異なる（前者はAgent起動条件、後者は状態変化の監査・増分取得）ため統合しない。Outcome確定はDirection側の`runtime_event`に新しい`event_type`として追加する。

## モジュール構成

現在のCompassは`src/domain/model/*.ts`、`src/application/usecase/*.ts`のようにBounded Contextを分けないflatな単一パッケージ構成である。kit/additional-doc.md §28のpackages分割は草案であり、現状の実装規模・チームサイズに対して過剰な構造変更になる。既存設計との整合と変更容易性を優先し、次の小さい選択を採る。

- 新規ファイルはDirection/Executionの境界が分かるようサブディレクトリで分ける: `src/domain/model/execution/`、`src/application/usecase/execution/`、`src/application/service/execution/`（`TaskCoordinationService.ts`等）、`src/infrastructure/repository/execution/`。既存のDirection関連ファイル（`src/domain/model/Project.ts`等）は移動しない（無用な差分を避ける）。
- MCP tool登録は`src/presentation/mcp/createMcpServer.ts`に引き続き集約する。1ファイルが肥大化する場合は、tool登録を`registerExecutionTools(server, services)`のような関数へ分割してこのファイルから呼び出す形に留め、MCPエンドポイント自体は分割しない（kit/additional-doc.md §29「外向きMCP Serverは一つでもよい」）。
- 将来、Execution機能が大きくなりpackages分割が必要になった場合は、この境界（`execution/`サブディレクトリ）がそのままpackage境界に昇格できるようにしておく。これは可逆な初期選択であり、Story側で改めて評価する。

## Project ID対応

旧WachaのProjectは「1つのbaseDir（ローカルGit checkout）に対応するTask管理スコープ」という設計だった。Compassはリモート配置を前提とし、Humanのローカルfilesystemやサーバー側checkoutに依存しない（AGENTS.md）。したがって次のように対応付ける。

| 旧Wacha概念 | Compassでの対応 |
| --- | --- |
| `project`（baseDir, projectName等） | Compassの既存`project`テーブルへ統合。Story/Taskは`project_id`として既存Project.idを直接使う。新規テーブルは作らない |
| Grant発行時のbaseDir/projectName解決 | 不要（Compass Projectは常にDBのidで一意）。Execution用のRole取得toolは無く、既存の`get_role_instructions`をそのまま使う |
| Worker/ManagerがGitの作業ディレクトリをどこに置くか | Compassは管理しない。Story/Taskが対象とする`project_repository_link.id`（Task 28のADR Handoffと同じ、既存Project.repositoriesの1件）を参照として持たせ、実際のcheckoutやfilesystemパスの決定は外部Runtime／Agent自身の責務とする |

`issue_story`（Manager起動時）は`repositoryId`（`project_repository_link.id`、任意）を受け付け、存在確認だけをapplication層で行う。RepositoryのURLからcloneするか、既にcheckout済みかはRuntime/Agent側の関心事であり、Compassは保持しない。

## DB schema / migration方針

`src/infrastructure/database/initializeSchema.ts`の既存パターン（`ifNotExists()`、`addColumnIfMissing()`によるべき等な追加）を踏襲し、専用マイグレーションフレームワークは導入しない。

新規テーブル（すべて`project_id`は既存`project.id`への参照、`create table if not exists`）:

| テーブル | 由来 | 主な変更点 |
| --- | --- | --- |
| `story` | Wacha `story` | `outcome_ref`（nullable, Direction `outcome.id`への参照。FKは付けない）、`origin_decision_id`（nullable, 参照のみ）、`success_criteria_snapshot`（JSON、作成時点のOutcome固定Success Criteriaの複製）、`constraints_snapshot`（JSON、作成時点のProject.constraintsの複製）、`correlation_id`（nullable）を追加 |
| `task` | Wacha `task` | フィールドはそのまま移植（id, project_id, story_id, title, description, status, assignee, reject_reason, resume_source_status, created_at, updated_at, sort_order） |
| `task_claim` | Wacha `task_claim` | フィールド・部分ユニークインデックス（`uq_task_claim_active_task ON task_claim(task_id) WHERE state='active'`）をそのまま移植 |
| `task_comment` | Wacha `task_comment` | そのまま移植 |
| `change_log` | Wacha `change_log` | そのまま移植。`project_id`は既存Compass Projectのid |
| `command_receipt` | Wacha `command_receipt` | そのまま移植（Execution toolのrequestId冪等性専用。Direction側の`request_key`+`input_hash`方式とは統一しない。理由は「実装記録: Direction/Execution idempotency方式の違い」参照） |

移植しないテーブル: 旧Wachaの`project`、`project_grant`（Compass既存の`project`/`project_grant`へ統合）、`skill`、`knowledge`（本Storyの範囲外）。

既存テーブルの変更（`addColumnIfMissing`）:

- `project_grant.role`: 型はstring（check制約なし）のため列変更不要。`src/constants/ProjectRole.ts`の`ProjectRole`定数に`MANAGER: "manager"`, `WORKER: "worker"`, `REVIEWER: "reviewer"`を追加するだけでよい。
- `runtime_event.event_type`: 既存は`"research_requested" | "research_completed"`のunion型。新しい値`"outcome_confirmed"`を追加する（Task 31/32で実装、Task 30では型・意味だけ決める）。

### 実装記録: Direction/Execution idempotency方式の違い（初期選択）

Direction側は各Entity（Research Request、Direction Decision等）に`request_key`+`input_hash`のunique indexを持たせる方式（Task 23で確立）。Execution側（旧Wacha）は`command_receipt`テーブルに`(principal_id, tool_name, request_id)`で結果を保存し再送時にリプレイする方式。両者は設計思想が異なるが、旧Wachaの`TaskCoordinationService`とその回帰テスト（`test/application/service/TaskCoordinationService.test.ts`）をそのまま移植する方針（Story本文「既存契約とテスト方針を優先して移植する」）を優先し、Execution側の冪等性方式は統一しない。境界をまたぐ操作（Manager起動時の`issue_story`）だけは、Direction側の慣習に合わせて`correlationId`を`outcome:{outcomeId}`のように決定的な値にし、`story`テーブルに`(project_id, correlation_id)`のunique indexを追加することで、Wachaの`requestId`冪等性と二重の安全網を持たせる（Task 25のInitial Research Requestと同じ考え方）。

## 起動・build構成

変更しない。`npm start`は`prestart`で`npm run build`（frontend build）を実行後、`tsx src/server.ts`で単一プロセスを起動する。`src/server.ts` → `createDatabase()` → `initializeSchema()` → `createApplicationServices()` → `src/app.ts`の`createApp()`が、同一Honoインスタンス・同一port上でWeb UI静的配信・`/api/*`・`/mcp`を提供する現行構成をそのまま維持する。Execution用のRepositoryやUse CaseはDirectionと同じ`createApplicationServices()`／`ApplicationServices`型に合流させ、`container.ts`のDI配線を1本にする（Wacha側の`container.ts`に相当する専用DIコンテナは作らない）。

内部連携のためのlocalhost HTTP呼び出しや別プロセスのMCPサーバーは導入しない。Execution機能は同一プロセス内のTypeScriptモジュールとして呼び出す。

## MCP tool統合方針

`src/presentation/mcp/createMcpServer.ts`（1つの`McpServer`インスタンス）へExecution toolを追加登録する。

移植するtool（Wachaの名称・入出力契約をそのまま踏襲）: `list_stories`, `list_tasks`, `list_task_comments`, `list_changes`, `issue_story`, `edit_story`, `complete_story`, `cancel_story`, `issue_task`, `edit_task`, `cancel_task`, `claim_task`, `claim_review`, `claim_acceptance`, `renew_claim`, `release_claim`, `add_task_comment`, `complete_task`, `reviewed_task`, `accept_task`, `reject_task`。

移植しないtool:

- `list_projects`（Wacha版「Principalに許可されたProjectの一覧」）: Compassは既に`list_projects`を持ち（Direction Project一覧、Grant不要で公開）、Project概念を統合したため別実装は不要。Execution toolはすべて既存の`get_project`/`list_projects`で得た`projectId`を入力に取る。
- `list_skills`, `get_skill_context`: Skill/Knowledge Entityは本Storyの範囲外（Story記述に明記なし）。将来必要になれば別Taskで検討する。
- `get_role_instructions`: 新設せず、既存tool（`src/presentation/mcp/createMcpServer.ts`の該当登録）をそのまま使う。`src/constants/ProjectRole.ts`の`projectRoles`にmanager/worker/reviewerを追加するだけで、既存の`InstructionService.getRoleInstructions(role, includeShared)`が`agent/manager.md`等を読めるようになる（tool定義・schemaは無変更）。

拡張するtool入力:

- `issue_story`: 任意項目として`outcomeId`（Direction `outcome.id`）、`repositoryId`（`project_repository_link.id`）、`correlationId`を追加する。`outcomeId`が指定された場合のみ、後述のDirection参照ポートで存在確認し、`success_criteria_snapshot`/`constraints_snapshot`/`origin_decision_id`（Outcomeの`origin_decision_id`があれば継承）を作成時に埋める。Human/Manager以外が任意作成するStoryなど`outcomeId`無しの従来利用（Wachaと同じ手動起票）も引き続き許可する。

## Role / Instruction配置

- `agent/manager.md`, `agent/worker.md`, `agent/reviewer.md`をWachaから移植する（役割名・ファイル名とも一致するため変更不要）。内容中の「session membership」「viewer role」等、Compassに存在しない旧方式への言及は移植時に削除する。
- `agent/role-policy.md`はCompassの既存ファイル（Bearer/Grant/エラーコード等、Direction/Execution共通の基盤事項を既に記述）に、Wachaの`agent/role-policy.md`が持つExecution固有の内容（Claimの排他性、自己review/自己accept禁止、reject意味論、Change Log運用）を追記する形でマージする。新しい共有ファイルは作らない（`get_role_instructions`の`includeShared=true`は引き続き1ファイルを返す契約を変えない）。マージ作業自体はTask 33で行う（本Taskは方針決定のみ）。
- 現在の`agent/role-policy.md`「配信しているRoleは`strategist`と`researcher`である」の記述、「変更履歴」節（「専用のChange Logや監査ログは現時点で無い」）は、Execution実装後は事実と異なるため、Task 33で更新が必要（review-documentation-impact Skillの対象）。

## Direction / Execution の所有Entityとapplication port

kit/additional-doc.md §25「Wachaが持たないもの: Mission/Vision/Intentの詳細/Strategic Decision/Outcome Evaluation」、§26「Shirubeが持たないもの: Task/Claim/Pull Request/Code Review/Agent Run」の原則を踏襲する。

| 所有側 | Entity | 相手側からのアクセス方法 |
| --- | --- | --- |
| Direction | Project, Intent, Outcome, Direction Decision, Research系 | Executionは直接読まない。`issue_story`作成時のみ、下記`DirectionReferenceLookupPort`経由でOutcome存在確認と値のsnapshotを1回取得する |
| Execution | Story, Task, Claim, Comment, Change Log | DirectionはStory/Task/Claimを直接読み書きしない。Task 34で導入する`ExecutionEvidencePort`経由で、確定したStory状態の要約だけをDirectionへ渡す |

application port（インターフェースはapplication層に置き、実装はinfrastructure層またはユースケースの直接呼び出しでよい。別プロセス・別HTTP経由にはしない）:

- `DirectionReferenceLookupPort`: `getOutcomeSnapshot(projectId, outcomeId): Promise<{ successCriteria, originDecisionId, constraints } | null>`。Execution側の`IssueStoryUseCase`が`outcomeId`指定時にのみ呼ぶ。実装は既存の`GetOutcomeUseCase`/`GetProjectUseCase`を内部で呼ぶだけの薄いadapterとする。
- `ExecutionEvidencePort`（Task 34で詳細確定）: `recordExecutionSummary(projectId, outcomeId, summary): Promise<void>`のような形で、DirectionがExecutionの`change_log`を増分取得した結果を取り込む入口。Story側は`accepted`/`rejected`/`canceled`/`incomplete`を区別した要約とEvidence参照（Wacha実行結果へのURI）だけを渡し、Story/Task本体を複製しない。

いずれのRepository・SQLite tableもDirection/Executionの境界を越えて直接importしない（`src/domain/repository`のinterfaceを介した一方向の参照読み取りのみ）。

## Runtime event契約（Task 31・32の前提）

既存`runtime_event`テーブル（Direction、Task 25で導入済み。cursor/ack契約と取得入口はTask 31で実装済み）と、新規`change_log`テーブル（Execution、Wachaの`list_changes`と同じcursor方式）の2系統を維持する。

| イベント種別 | 保存先 | 発火条件 | Runtimeの反応 |
| --- | --- | --- | --- |
| `research_requested` | `runtime_event` | Research Request作成（既存） | Researcher起動 |
| `research_completed` | `runtime_event` | Research Request確定（既存） | Strategist起動 |
| `outcome_confirmed`（新規, Task 31/32で実装） | `runtime_event` | `create_outcome`/`decide_next_outcome`成功と同一transaction | Manager起動（`issue_story`等でStory/Task作成） |
| Story/Task状態変化一式（`TASK_CLAIMED`等、Wachaの既存Change種別） | `change_log`（Execution） | 各Execution操作と同一transaction | Manager/Worker/Reviewer起動の判断材料、Task 34のEvidence還流のトリガー |

- 取得はいずれも`cursor`昇順、Project scope、`afterCursor`＋`limit`のページング。`change_log`はAck/配送保証を持たず、Runtimeがcursorを保持して差分取得する（既存の`list_changes`・Task 25設計と同じ考え方）。`runtime_event`だけは、Task 31の要件に従いconsumer単位のackをCompassが記録する（`runtime_event_delivery`。実装記録は`docs/research-decision-adr-design.md`の「Runtime eventのcursor・ack公開（Task 31）」）。Runtimeのプロセス生存・polling・retry間隔は引き続き管理しない。
- Web API/MCPの取得入口は`runtime_event`側がTask 31で実装済み（`fetch_runtime_events` / `ack_runtime_event`、`GET /api/projects/:projectId/runtime-events`・`POST .../:eventId/ack`）。`change_log`側はWachaの`list_changes`をそのまま移植すれば入口ごと揃う（Task 33）。
- 認証はTask 37の不透明Credential（Runtime用scope）が前提。Task 30時点・Task 31実装時点では、既存のtrusted-local Bearer方式を暫定的に使い、remote配置時の認証はTask 37で置き換える（既存のtrusted-local注記をREADME/設計文書に明記する）。

## 冪等性・相関ID・再起動時の回復規則

- Execution内の操作（claim/complete/review/accept等）は、Wachaの`requestId`＋`command_receipt`方式をそのまま使う（上記「idempotency方式の違い」参照）。
- DirectionからExecutionへのhandoff（Outcome確定 → Manager起動 → `issue_story`）は、`outcome:{outcomeId}`形式の決定的`correlationId` + `story`テーブルの`(project_id, correlation_id)` unique indexで、Runtimeの重複起動・`issue_story`の重複呼び出しのいずれでも二重Story作成を防ぐ。
- ExecutionからDirectionへの還流（Task 34）も、`change_log`の`cursor`を還流側が保持し、同じcursor範囲の再取込みでも重複しないよう、還流結果テーブルに`(project_id, outcome_id, change_log_cursor)`程度の一意性を持たせる方針とする（詳細はTask 34で確定）。
- サーバー再起動時は、`runtime_event`/`change_log`いずれも追記のみのテーブルであるため、Runtime側が保持するcursorから再開すれば欠落なく再取得できる。CompassはRuntimeのプロセス生存やスケジュールを管理しない（kit/additional-doc.md §3, §27の責任分離どおり）。

## Task 31〜38への反映

- **Task 31（実装済み）**: `runtime_event`のcursor/ack付きWeb API/MCP入口を実装した。認可は暫定の`runtime` Role Grant（Task 37でRuntime Credential scopeへ置き換え）。本Taskの契約（cursor昇順、Project scope、認証は暫定trusted-local）に従う。`outcome_confirmed`はまだ存在しない前提でよい（Task 32が追加）。
- **Task 32**: `additional_research` Direction Decisionから追加Research Requestを作る確定経路。本Taskの変更は無し（既存のResearch集約の冪等性パターンをそのまま踏襲）。
- **Task 33**: 本Taskの「モジュール構成」「DB schema」「MCP tool統合方針」「Role/Instruction配置」に従い、旧Wacha Execution一式を移植する。あわせて`outcome_confirmed`イベントを`CreateOutcomeUseCase`/`DecideNextOutcomeUseCase`に追加し、`DirectionReferenceLookupPort`を実装し、`issue_story`の`outcomeId`拡張を実装する。`agent/role-policy.md`のマージ、README等のドキュメント更新もここで行う。
- **Task 34**: 本Taskの「Direction/Executionの所有Entityとapplication port」「冪等性」節にある`ExecutionEvidencePort`の詳細（テーブル形状、`change_log`増分取込みの単位）をTask内で確定する。
- **Task 35〜36**: 本Taskの決定に影響される変更なし（Outcome EvaluatorはDirection側のEntityであり、Executionとは`ExecutionEvidencePort`経由のEvidenceだけを介する）。
- **Task 37**: 本Taskで「暫定trusted-local」とした認証を、Agent/Runtime向け不透明Credentialへ置き換える。`runtime_event`/`change_log`双方の取得APIが対象に含まれる。
- **Task 38**: 本Taskで決めたRuntime event契約・冪等性規則を実際にE2Eで検証する。

## 未接続・未実装・対象外（本Task時点）

- 上記の決定はすべて設計であり、コード・DB・UIへの反映は未実施。`runtime_event`のRuntime向け入口、`change_log`、`story`/`task`等のExecutionテーブル、`manager`/`worker`/`reviewer`のGrant/Instruction配信は本Task完了時点でいずれも未実装。
- localhost HTTP/MCP loopbackや別Wachaサーバーとの接続は行っておらず、今後も恒久構成として採用しない。
- fixtureによる契約検証はTask 28/29までの既存実装と同様の位置づけであり、本Taskはfixtureすら作らない（設計文書のみ）。
- Skill/Knowledge Entityの移植、Cloudflare等への実配置、Task 37のCredential実装は本Storyの他Taskまたは別Storyの対象であり、本Taskでは扱わない。
