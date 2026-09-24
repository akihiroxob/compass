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
- `runtime_event.event_type`: 既存は`"research_requested" | "research_completed"`のunion型。新しい値`"outcome_confirmed"`を追加する（Task 33で実装、Task 30では型・意味だけ決める）。

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
| Execution | Story, Task, Claim, Comment, Change Log | DirectionはStory/Task/Claimを直接読み書きしない。Task 34で導入した読取専用の`ExecutionSummaryPort`経由で、DirectionがStory / Task状態の要約だけを導出して受け取る（「実装記録（Task 34）」） |

application port（インターフェースはapplication層に置き、実装はinfrastructure層またはユースケースの直接呼び出しでよい。別プロセス・別HTTP経由にはしない）:

- `DirectionReferenceLookupPort`: `getOutcomeSnapshot(projectId, outcomeId): Promise<{ successCriteria, originDecisionId, constraints } | null>`。Execution側の`IssueStoryUseCase`が`outcomeId`指定時にのみ呼ぶ。実装は既存の`GetOutcomeUseCase`/`GetProjectUseCase`を内部で呼ぶだけの薄いadapterとする。
- `ExecutionEvidencePort`（Task 30時点の案。Task 34で読取専用の`ExecutionSummaryPort`に置き換えた）: `recordExecutionSummary(projectId, outcomeId, summary): Promise<void>`のような形で、DirectionがExecutionの`change_log`を増分取得した結果を取り込む入口を想定していた。Story側は`accepted`/`rejected`/`canceled`/`incomplete`を区別した要約とEvidence参照（Wacha実行結果へのURI）だけを渡し、Story/Task本体を複製しない。

いずれのRepository・SQLite tableもDirection/Executionの境界を越えて直接importしない（`src/domain/repository`のinterfaceを介した一方向の参照読み取りのみ）。

## Runtime event契約（Task 31・32の前提）

既存`runtime_event`テーブル（Direction、Task 25で導入済み。cursor/ack契約と取得入口はTask 31で実装済み）と、新規`change_log`テーブル（Execution、Wachaの`list_changes`と同じcursor方式）の2系統を維持する。

| イベント種別 | 保存先 | 発火条件 | Runtimeの反応 |
| --- | --- | --- | --- |
| `research_requested` | `runtime_event` | Research Request作成（既存） | Researcher起動 |
| `research_completed` | `runtime_event` | Research Request確定（既存） | Strategist起動 |
| `outcome_confirmed`（新規, Task 33で実装済み） | `runtime_event` | `create_outcome`/`decide_next_outcome`成功と同一transaction | Manager起動（`issue_story`等でStory/Task作成） |
| `outcome_evaluated`（新規, Task 36で実装済み） | `runtime_event` | `record_outcome_evaluation`の新規保存と同一transaction（Evaluationごとに1件） | Strategist起動（Evaluationを根拠に再計画またはIntent完了を判断） |
| Story/Task状態変化一式（`TASK_CLAIMED`等、Wachaの既存Change種別） | `change_log`（Execution） | 各Execution操作と同一transaction | Manager/Worker/Reviewer起動の判断材料、Task 34のEvidence還流のトリガー |

- 取得はいずれも`cursor`昇順、Project scope、`afterCursor`＋`limit`のページング。`change_log`はAck/配送保証を持たず、Runtimeがcursorを保持して差分取得する（既存の`list_changes`・Task 25設計と同じ考え方）。`runtime_event`だけは、Task 31の要件に従いconsumer単位のackをCompassが記録する（`runtime_event_delivery`。実装記録は`docs/research-decision-adr-design.md`の「Runtime eventのcursor・ack公開（Task 31）」）。Runtimeのプロセス生存・polling・retry間隔は引き続き管理しない。
- Web API/MCPの取得入口は`runtime_event`側がTask 31で実装済み（`fetch_runtime_events` / `ack_runtime_event`、`GET /api/projects/:projectId/runtime-events`・`POST .../:eventId/ack`）。`change_log`側はWachaの`list_changes`をそのまま移植すれば入口ごと揃う（Task 33）。
- 認証はTask 37の不透明Credential（Runtime用scope）が前提。Task 30時点・Task 31実装時点では、既存のtrusted-local Bearer方式を暫定的に使い、remote配置時の認証はTask 37で置き換える（既存のtrusted-local注記をREADME/設計文書に明記する）。

## 冪等性・相関ID・再起動時の回復規則

- Execution内の操作（claim/complete/review/accept等）は、Wachaの`requestId`＋`command_receipt`方式をそのまま使う（上記「idempotency方式の違い」参照）。
- DirectionからExecutionへのhandoff（Outcome確定 → Manager起動 → `issue_story`）は、`outcome:{outcomeId}`形式の決定的`correlationId` + `story`テーブルの`(project_id, correlation_id)` unique indexで、Runtimeの重複起動・`issue_story`の重複呼び出しのいずれでも二重Story作成を防ぐ。
- ExecutionからDirectionへの還流（Task 34）も、`change_log`の`cursor`を還流側が保持し、同じcursor範囲の再取込みでも重複しないよう、Task 34では、Outcomeごとに1行の要約を`execution_cursor`が進むときだけ上書きし、Evidenceを`(outcome, kind, uri, version)`で一意にして収束させた（「実装記録（Task 34）」）。
- サーバー再起動時は、`runtime_event`/`change_log`いずれも追記のみのテーブルであるため、Runtime側が保持するcursorから再開すれば欠落なく再取得できる。CompassはRuntimeのプロセス生存やスケジュールを管理しない（kit/additional-doc.md §3, §27の責任分離どおり）。

## Task 31〜38への反映

- **Task 31（実装済み）**: `runtime_event`のcursor/ack付きWeb API/MCP入口を実装した。認可は暫定の`runtime` Role Grant（Task 37でRuntime Credential scopeへ置き換え）。本Taskの契約（cursor昇順、Project scope、認証は暫定trusted-local）に従う。`outcome_confirmed`はTask 33で追加した。
- **Task 32（実装済み）**: `additional_research` Direction Decisionから追加Research Requestと`research_requested`イベントを作る確定経路。本Taskの設計変更は無し（既存のResearch集約の冪等性パターンを踏襲）。実装記録は`docs/research-decision-adr-design.md`の「追加Research判断のRequest・Runtimeイベント接続（Task 32）」。
- **Task 33（実装済み）**: 実装記録は本文書末尾の「実装記録（Task 33）」。本Taskの「モジュール構成」「DB schema」「MCP tool統合方針」「Role/Instruction配置」に従い、旧Wacha Execution一式を移植する。あわせて`outcome_confirmed`イベントを`CreateOutcomeUseCase`/`DecideNextOutcomeUseCase`に追加し、`DirectionReferenceLookupPort`を実装し、`issue_story`の`outcomeId`拡張を実装する。`agent/role-policy.md`のマージ、README等のドキュメント更新もここで行う。
- **Task 34（実装済み）**: 実装記録は本文書末尾の「実装記録（Task 34）」。`ExecutionEvidencePort`の詳細（テーブル形状、増分取込みの単位）はTask内で確定し、書込ポートではなく読取専用の`ExecutionSummaryPort`にした。
- **Task 35〜36（実装済み）**: 本Taskの決定に影響される変更なし（Outcome EvaluatorはDirection側のEntityであり、Executionとは、Task 34で還流したExecution SummaryとEvidence参照だけを介する）。
- **Task 37**: 本Taskで「暫定trusted-local」とした認証を、Agent/Runtime向け不透明Credentialへ置き換える。`runtime_event`/`change_log`双方の取得APIが対象に含まれる。
- **Task 38**: 本Taskで決めたRuntime event契約・冪等性規則を実際にE2Eで検証する。

## 未接続・未実装・対象外（Task 30時点の記録。現在の状況は「実装記録（Task 33）」）

- 上記の決定はすべて設計であり、コード・DB・UIへの反映は未実施。`runtime_event`のRuntime向け入口、`change_log`、`story`/`task`等のExecutionテーブル、`manager`/`worker`/`reviewer`のGrant/Instruction配信は本Task完了時点でいずれも未実装。
- localhost HTTP/MCP loopbackや別Wachaサーバーとの接続は行っておらず、今後も恒久構成として採用しない。
- fixtureによる契約検証はTask 28/29までの既存実装と同様の位置づけであり、本Taskはfixtureすら作らない（設計文書のみ）。
- Skill/Knowledge Entityの移植、Cloudflare等への実配置、Task 37のCredential実装は本Storyの他Taskまたは別Storyの対象であり、本Taskでは扱わない。

## 実装記録（Task 33）

旧Wacha Executionの移植と、Outcome起点のhandoffを実装した。上記の設計に従い、次の点を初期選択として決めた。

### 実装した範囲

- **ProjectRole**: `manager` / `worker` / `reviewer`を追加。Web UIのGrant画面（Project詳細）にも3 sectionを追加した（Humanの発行・取消はWeb UI）。CLIのroleヘルプ・検証も追随する。
- **Execution table**: `story` / `task` / `task_claim` / `task_comment` / `change_log` / `command_receipt`を`initializeSchema`へ冪等に追加（`create ... if not exists`）。`story`に`outcome_ref` / `origin_decision_id` / `success_criteria_snapshot` / `constraints_snapshot` / `repository_snapshot` / `correlation_id`を持ち、`(project_id, correlation_id)`にunique indexを張る（NULLは制約の対象外なので手動起票のStoryは影響を受けない）。旧Wachaの`task_comment.session_id`（廃止済みのsession方式の残り）は移植していない。
- **service**: `src/application/service/execution/TaskCoordinationService.ts`。旧Wachaの状態遷移・Role検査・排他Claim・自己review / 自己受入の禁止・`command_receipt`によるrequestId冪等性・Change Logを変えずに移した。変えたのは、グローバルなDBクライアントをやめて`Kysely<Database>`をコンストラクタで注入すること、Claim期限の環境変数を`COMPASS_CLAIM_TTL_MS`にしたこと、`session_id`の除去、trusted-local Web UI用のoperator受入 / 差戻し / 取消、`listProjects` / `assertProject*`（Wacha側のWeb UI用）を移植しなかったことだけ。旧WachaもこのserviceがSQLを直接持つ構造で、「同じ概念の再実装を避ける」ため、Repository interfaceへの分割はしていない。
- **MCP**: `src/presentation/mcp/registerExecutionTools.ts`が21個のExecution toolを、Directionと同じ`McpServer`（同一`/mcp`）へ登録する。tool名は旧Wachaのまま。PrincipalなしはUNAUTHENTICATED。CoordinationErrorは旧Wachaと同じ`{ error: { code, message, retryable } }`（本文`CODE: message`）で返す。`result` / `execute`は`toolExecution.ts`へ移し、Direction・Execution両方が使う。
- **Instruction**: `agent/manager.md` / `worker.md` / `reviewer.md`を旧Wachaから移し、Compassの前提（Human承認を挟まない通常フロー、Outcome起点のhandoff、Success Criteriaはsnapshotで変更しない）に合わせた。`agent/role-policy.md`へClaim・状態遷移・エラーコード・Change Logを追記した。`agent/runtime.md`に`outcome_confirmed`後の扱いを追記した。

### handoff（Direction → Execution）

- **`outcome_confirmed`**: `insertOutcomeRow`（`create_outcome`と`decide_next_outcome`の両方が通る）が、Outcomeと同一transactionでイベントを保存する。相関IDは`outcome:{outcomeId}`（`src/shared/outcomeCorrelation.ts`。DirectionとExecutionの双方が使う取り決めで、どちらのEntityにも依存しない）。`runtime_event`は`event_type`のCHECKと`research_request_id`のNOT NULLを変える必要があるため、起動時にSQLite公式手順（新tableを作って写し、旧tableをdropしてrename。`sequence`とautoincrementの高水位・`runtime_event_delivery`のFKを保持。FKチェック付き、新定義なら何もしない）で作り直す。`outcome_id`列とunique indexを追加し、`research_request_id` / `outcome_id`のどちらが値を持つかをCHECKでイベント種別に結び付けた。
- **`issue_story`の拡張**: `outcomeId` / `repositoryId` / `correlationId`（任意）。Directionの参照は`DirectionReferenceLookupPort`（読取専用。実装`DirectionReferenceLookupService`はOutcome・ProjectのRepositoryインターフェースを読むだけ）だけを通り、Story作成のtransactionの前に解決する（SQLiteの接続はtransaction中は1本を占有するため）。manager Grantの検査を先に行い、権限の無い呼び出しにOutcome・Repositoryの存在を漏らさない。再送（同じ`requestId`、または同じ相関IDの既存Story）では参照の解決を省き、参照先が後で変わっても元のStoryを返す。同じ相関IDに別内容ならIDEMPOTENCY_CONFLICT。
- **設計からの差分**: Repositoryは存在確認だけでなく`repository_snapshot`（`{id, name, url}`）を保存する（`update_project`で`project_repository_link`のIDが変わってもWorkerが対象を辿れるように）。Success Criteriaのsnapshotには、Task 35のEvaluatorが辿れるようcriterionの`id`と`position`を含める。`issue_task`でStory配下にTaskを作るとき、Storyが相関ID・Outcomeを持てば`TASK_CREATED`のChange payloadへ引き継ぐ（Task 34がChange Logから辿るため。Task 34で`list_changes`の応答へも`outcomeId` / `correlationId`を付けた）。
- **失敗の区別**: Bearerなし=UNAUTHENTICATED、Grant無し・存在しないProject=FORBIDDEN（存在を漏らさない）、別ProjectのOutcome / 存在しないOutcome・Repository=NOT_FOUND、取消済みOutcome・archived Project=CONFLICT、入力不正=INVALID_INPUT。いずれもStoryを部分的に残さない。
- **archived Project**: 設計文書には無かったが、Step 5の「archivedでは新しい活動を始めない」に合わせ、`issue_story` / `issue_task` / `claim_task`を`ProjectArchivedError`（CONFLICT）で拒否する。参照、既に`doing`のTaskの完了・review・受入は妨げない。

### 境界

Executionのコードが読み書きするtableは、Execution自身のtableと共有の根（`project`の状態確認、`project_grant`のRole検査。どちらも読むだけ）に限る。Directionのtable・Repository・use case・modelはimportせず、`DirectionReferenceLookupPort`だけを通る。Directionのコードは、Executionのtable・serviceを直接使わない（配線する`createApplicationServices.ts`とMCP公開層を除く）。`test/executionBoundary.test.ts`がソースを静的に走査して検証する。別Wacha server・localhost HTTP / MCPは使わない（同一プロセス内のモジュール呼び出し）。

### 実装済み・未接続・未検証

- 実装済み: 上記。検証: 旧Wachaのservice回帰テストの移植（19件）、統一`/mcp`経由（実MCP SDK clientでの実server起動を含む手動確認）、handoffの冪等性・snapshot・失敗分類・並行・再起動、`runtime_event`マイグレーション、境界。
- 未接続: 外部Runtimeによる`outcome_confirmed`の取得とManagerの起動（テスト内のMCP呼び出しがRuntimeを模す）。Execution → Directionの還流の起動（Task 34で入口は実装済み。起動するRuntimeは未接続）、Evaluationの起動と遷移（Task 35で保存、Task 36で再計画・Intent完了への遷移を実装。起動するRuntimeは未接続）、不透明Credential（Task 37。認証は引き続きtrusted-local）。
- 対象外・移植せず: 旧WachaのWeb UI（Project Activity・Task drawer等）とその`PageController`、`list_projects` / Skill / Knowledge。HumanがExecutionのStory・Taskを閲覧・操作するWeb UI / APIは未実装（後続で判断する）。
- 未検証: fixtureやテスト内呼び出しによる確認はLv6の自律運転の実証ではない。

## 実装記録（Task 34）

ExecutionのStory / Task / Change Logから、Outcome評価に必要なExecution SummaryとEvidence参照をDirectionへ還流する経路を実装した。Task 30の`ExecutionEvidencePort`（Directionへ「書く」ポート）は採らず、次の初期選択にした。

### 初期選択と理由

- **Directionが読む、読取専用ポート（`ExecutionSummaryPort`）にした**。設計時は`recordExecutionSummary`のようにExecutionから書き込む形を想定していたが、それだとExecution層がDirectionの保存先を知る必要があり、「Execution層もOutcome repositoryを直接更新しない」に反する。DirectionのUse Case（`RecordExecutionEvidenceUseCase`）が`ExecutionSummaryPort.getOutcomeExecutionSummary(projectId, outcomeId)`を呼び、実装`ExecutionSummaryService`（`src/application/service/execution/`）がExecution自身のtable（story / task / change_log）だけを読む。Direction層はExecutionのRepository・tableを、Execution層はOutcomeのRepository・tableを使わない（`test/executionBoundary.test.ts`が静的に確認）。
- **結果はRuntimeの申告ではなくExecutionの現在の状態から導出する**。Runtimeが渡すのは`changeCursor`とEvidence参照だけ。導出のたびに現在の状態から計算するので、通知の重複・順序逆転・再起動後の再送でも同じ最終状態に収束する。導出規則: Storyは、キャンセル済みなら`canceled`、Taskが無ければ`incomplete`、進行中（todo / doing / in_review / wait_accept）のTaskがあれば`incomplete`、無くて未解決の`rejected`があれば`rejected`、有効なTaskがすべて`accepted`なら`accepted`、有効なTaskが無ければ`canceled`。Outcomeは、キャンセル済みでないStoryの中で`incomplete` > `rejected` > `accepted`の順に採り、すべてキャンセルなら`canceled`。
- **Outcomeとの対応はStoryの`outcome_ref`**（Task 33で保存）。相関IDは`outcome:{outcomeId}`。`list_changes`はStory・Taskの変更に`outcomeId` / `correlationId`を付け（読取時にstory / taskから解決。Change Logのpayloadは変更しない）、Runtimeが還流の対象を辿れるようにした。
- **保存先はDirection所有の2 table**。`outcome_execution_summary`はOutcomeごとに1行で、`execution_cursor`（要約が反映するExecution側の最新Change cursor）が進むときだけ上書きし、`observed_cursor`にRuntimeが報告した最大のcursorを持つ。`outcome_execution_evidence`は`(outcome, kind, uri, version_hash)`の一意index（`version_hash`無しは空文字として扱う）で重複を防ぎ、`source_change_cursor`・`observed_at`・`principal_id`を持つ。Evidence本文は保存せず、1 Outcomeあたり200件を上限にした（無制限な複製を防ぐ）。`(Outcome, cursor)`単位の還流結果tableは、要約が上書きで収束するため持たない。
- **入口**: MCP `record_execution_evidence` / `get_outcome_execution_summary`、Web API `POST /api/projects/:projectId/outcomes/:outcomeId/execution-evidence`・`GET .../execution-summary`。書込・MCPの読取は`runtime` Grantが必要（Task 37で置き換える暫定Role）。Web APIのGETはHuman向けの読み取りでGrantを要求しない。
- **拒否**: 別Project・存在しないOutcomeは`NOT_FOUND`（存在を区別しない）。Storyが無い（未着手）・取消済みOutcome・archived Project・Evidence上限は`CONFLICT`。相対 / 非http / 認証情報付きURI、40桁でないSHA、SHAの無い`commit`、未来（5分を超える）の`observedAt`、Change Logの最新cursorより先の`changeCursor`は`VALIDATION_ERROR`。拒否では何も保存しない。古い`changeCursor`は拒否せず、状態を巻き戻さず現在の状態で回復する（`recorded.staleInput`）。
- **Success Criterionは判定しない**。`accepted`でもOutcomeを変更せず、Success Criterionの充足とも扱わない。判定はEvaluation（Task 35で保存を実装、遷移はTask 36）の責務。

### 実装済み・未接続・未検証

- 実装済み: 上記。`test/executionEvidence.test.ts`が、実MCP / Web API経由で進行に応じた状態、4区分、再送・順序逆転・並行・ファイルDBの再起動、拒否、Executionが変わらないことを確認する。
- 未接続: Change取得から還流を起動する外部Runtime（テスト内の呼び出しがRuntimeを模す）。EvidenceのURI・commit SHAを実GitHub等で実在確認しないこと（形式の検証のみ。Repositoryとの対応検証も行っていない）。Evaluation。不透明Credential（認証はtrusted-localのまま）。
- 未検証: fixtureやテスト内呼び出しによる確認はLv6の自律運転の実証ではない。


## 実装記録（Task 35）

固定Success CriteriaとTask 34のEvidenceを入力に、Outcome Evaluationを保存するdomain・repository・use case・`evaluator` Role・Instruction・MCP tool（`get_evaluator_context` / `record_outcome_evaluation`）を実装した。Task 36（再計画・Intent完了への遷移）と起動するRuntimeは含まない。

### 初期選択と理由

- **総合結果は指定させず、Criterionの判定から導出する**。Evaluatorが総合結果を直接送ると、判定と食い違う保存を許す。導出規則は、すべて`met`のときだけ`achieved`、`not_met`が1つでもあれば`failed`（他のCriterionが`insufficient_evidence`でも、Outcomeは達成できていない）、それ以外は`insufficient_evidence`。Executionの`accepted`は入力に影響せず、`achieved`にはCriterionの観測結果が要る。
- **根拠のない`met` / `not_met`を保存しない**。`met` / `not_met`は、このOutcomeに還流済みのEvidence参照（`evidenceIds`）を1件以上必要とし、別Outcomeや存在しない参照は`VALIDATION_ERROR`。観測できないものは`insufficient_evidence`（参照なしでよい）。すべてのSuccess Criterionを1回ずつ判定させる（不足・重複・別OutcomeのCriterionは`VALIDATION_ERROR`）。
- **評価できるのは、activeなOutcomeでExecution Summaryが還流済みのものだけ**。未還流は`CONFLICT`（`reason: no_execution_summary`）にして、Executionが動いていないOutcomeに`insufficient_evidence`を積み、Task 36の再計画を誤って起こさないようにした。Execution Summaryの`state`（`incomplete`等）では評価を止めない。判断はEvaluatorに任せ、snapshotへ残す。
- **Evaluationは追記のみ**。`outcome_evaluation`（Direction所有）は更新・削除しない。再評価は新しい`requestKey`の追記で、最新が現在の結果。Outcomeの`status`（`evaluating` / `achieved` / `not_achieved`は予約のまま）・Success Criteria・Executionは変更しない。Criterion・snapshotはJSONで保存し、Criterionの定義（description・measurement・target・position）とOutcome・Execution Summary・Evidence参照（`id`・kind・uri・versionHash・observedAt。本文なし）を評価時点で写す。
- **冪等性は`(project_id, request_key)`の一意indexと内容hash**。hashは判定の並び順・`evidenceIds`の並び順に依存せず、snapshotと導出結果は含めない。再送は状態の検査より先に確認するため、評価後にOutcomeやExecutionが変わっても、応答を失った再送は最初の評価を返す（`recorded: false`）。異なる内容は`CONFLICT`。
- **職務分離**。`evaluator`はOutcome定義（strategist Grant）・Execution結果の還流（runtime Grant）・Story / Task（manager / worker / reviewer Grant）のtoolを持たず`FORBIDDEN`になる。`update_project` / `create_intent` / `update_intent` / `abandon_intent`も、strategist・researcherに加えevaluatorのGrantを持つPrincipalに拒否する。trusted-localではAgent名を変えれば回避できるため、構造上の保証（該当tool側のRole検査）が本体（Task 37で不透明Credentialへ置き換える）。
- **Strategist / Researcherの`unavailable`は変えない**。`evaluation`を外すのは、Evaluatorが実際に接続され、Evaluationを含むStrategist ContextをTask 36で提供した後にする。Web UIのGrant発行画面は`evaluator`を追加しない（`runtime`と同じ扱い。Web APIとCLIは対応）。Human向けのEvaluation閲覧用Web API / UIは持たない。

### 実装済み・未接続・未検証

- 実装済み: 上記。`test/outcomeEvaluation.test.ts`が、実MCP経由の保存・導出・根拠の検証・網羅性・冪等性（並び順違い・評価後のExecution進行・ファイルDBの再起動）・拒否（Role・別Project・取消済みGrant・Bearerなし）・状態（未還流・取消済み・archived）・Outcome / Execution / Project / Intentを変更できないこと・`unavailable`の維持を確認する。
- 未接続: Evaluatorの起動（`outcome_confirmed`のように、Evaluation用のRuntime eventは作っていない）。Evaluationからの再計画・次のOutcome判断・Intent完了（Task 36）。Evidence参照先を実際に取得して観測する処理（Evaluatorの責務で、Compassは参照の形式しか見ない）。不透明Credential（認証はtrusted-localのまま）。
- 未検証: fixtureやテスト内呼び出しによる確認はLv6の自律運転の実証ではない。

## 実装記録（Task 36）

Task 35のEvaluation確定を起点に、Strategistの起動イベント、Evaluationを根拠にした再計画（次のOutcome・追加Research）とIntent完了を接続した。

### 初期選択と理由

- **起動イベントは`outcome_evaluated`（`runtime_event`）**。Evaluationの新規保存と同一transactionで、Evaluationごとに1件作る（`evaluation_id`のunique index。再送では作らない）。結果（achieved / failed / insufficient_evidence）によらずStrategistの起動条件にし、分岐はStrategistが判断する（Compassは次のOutcomeもIntent完了も自動で決めない）。相関IDはOutcomeと同じ`outcome:{outcomeId}`で、確定 → Execution → 評価 → 再計画を1本で辿れる。`runtime_event`はCHECKの変更が要るため、Task 33と同じSQLite公式手順でtableを作り直す（旧定義の列だけを写し、`sequence`・高水位・ackを保持）。Outcomeごとに1件だった一意索引は`outcome_confirmed`だけの部分索引にした（再評価のたびに`outcome_evaluated`が増えるため）。
- **判断はDirection Decisionに`evaluationId`を付けて記録する**。新しいDecision typeやtoolは作らず、`decide_next_outcome`（next_outcome）と`create_direction_decision`（additional_research / intent_complete）に任意の`evaluationId`を足した。記録だけの判断（intent_abandon / policy_proposal / adr_candidate）は受け付けない。
- **1つのEvaluationを根拠にできるDecisionは1件だけ**（`direction_decision.evaluation_id`の部分unique index）。同じ`outcome_evaluated`でStrategistが重複起動・timeout後に再起動されても、次のOutcome・追加Research・Intent完了を二重にしない。同じ`requestKey`の再送は従来どおり同じDecisionを返す。
- **古いEvaluationからは遷移しない**。同じOutcomeの最新Evaluationだけを根拠にでき（`evaluation_not_latest`）、取消済みOutcomeの評価（`evaluation_outcome_not_active`）、active以外のIntent（既存の`intent_not_active`）、archived Projectも`CONFLICT`。別Project・別IntentのEvaluationは`VALIDATION_ERROR`。Intentがactiveでない（達成済み・中止）Outcomeは、Evaluation自体を保存しない（`record_outcome_evaluation`の`CONFLICT`、`reason: intent_not_active`）ため、起動イベントも作られない。
- **Intent完了はachievedのEvaluationとcompletionDefinitionが揃ったintent_completeだけ**。intent_completeは`evaluationId`必須で、achieved以外は`evaluation_result_mismatch`、完了定義の無いIntentは`no_completion_definition`（完了定義の設定はHumanの責務でStrategistは変更しない）。条件を満たせば同一transactionでIntentを`achieved`にする。Outcome達成とIntent達成は同一視せず、achievedでもIntentが未完了なら同じEvaluationで次のOutcomeを判断する。Execution完了・単一Outcome達成でIntentを自動達成にする経路は無い。
- **Outcomeの状態は変えない**。`evaluating` / `achieved` / `not_achieved`は予約のまま。再計画後も元Outcomeは`active`で残り、現在の結果は最新Evaluationで表す（状態遷移を増やすと、再評価・取消との整合が要るため初期選択では持たない）。
- **Strategist Context**: `evaluations`にActive Intent配下の各Outcomeの最新Evaluation（Criterionごとの判定・根拠・snapshot）と、それを根拠にしたDecisionの`decisionId`（未判断はnull）を返し、`unavailable`から`evaluation`を外した（`evidence`＝Evidence本文は残る）。Researcher Contextは変えていない。

### 実装済み・未接続・未検証

- 実装済み: 上記。`test/evaluationReplan.test.ts`が、実MCP経由でイベントの1件化（再送・再評価）、failed → 次のOutcome、insufficient_evidence → 追加Research、achieved → Intent完了 / 次のOutcome、重複判断・古いEvaluation・別Project・取消済みOutcome・中止Intent・archived Project・完了定義なし・非achievedでの拒否、Task 35時点のDBのマイグレーションと再起動後の保持を確認する。
- 未接続: `outcome_evaluated`を取得してStrategistを起動する外部Runtime、Evaluatorの起動（テスト内の呼び出しがRuntime・Agentを模す）。Human向けにEvaluationや根拠Evaluationを表示するWeb UI（Intentの`achieved`表示は既存UIのまま）。不透明Credential（Task 37）。
- 未検証: fixtureやテスト内呼び出しによる確認はLv6の自律運転の実証ではない。
