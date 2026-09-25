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

## Web UIの配置と移行順（Task 30再レビューで確定）

AGENTS.mdの「Humanの製品操作はWeb UIを正規入口とする」に従い、Execution・Evaluationを含めてHumanが行う操作はCompass Web UIから行えるようにする。PdMの指示（Task 30コメント「UIはガンガン変更していいよ」）により、UI追加・変更は本Storyの範囲で行ってよい。旧WachaのUI（`/Users/aokayama/git/wacha/src/frontend`）はコードをそのまま持ち込まず、Compassの`src/frontend/features/`単位の構成・既存Component・styleへ合わせて機能だけを移す。

### 旧Wacha UIの移植・非移植

| 旧Wacha UI / API | 扱い | Compassでの配置 |
| --- | --- | --- |
| `ProjectListPage` / `ProjectCard`、`GET /api/projects` | 移植しない | Compass既存のProject一覧に一本化（Project概念は統合済み） |
| `RoleGrantDrawer`、`POST/DELETE /api/projects/:id/grants` | 移植しない | Compass既存の`features/grant`の`GrantSection`（Project詳細）。Execution系を含む全Roleをここで発行・一覧・取消する |
| `ProjectDetailPage`のStory / Task一覧（`StoryCard` / `TaskCard`） | 移植する | 新Feature `features/execution`。Project詳細に「Execution」sectionを置き、Story（状態、紐づくOutcome、相関ID）とTask（状態、担当、Claim期限）を表示。Outcome詳細にはそのOutcomeを参照するStoryだけを表示する |
| `ProjectActivity`、`GET /api/projects/:id/activity` | 移植する | Execution sectionの「最近の変更」。`change_log`をcursor順に表示する（Web API `GET /api/projects/:projectId/changes`。MCP `list_changes`と同じapplication層） |
| `TaskDrawer`（description、Comment、状態、差戻し理由） | 移植する | drawerではなくTask詳細画面 `/projects/:projectId/tasks/:taskId`（Compassは詳細を画面で持つ既存方針のため）。Comment一覧と当該TaskのChange履歴を表示 |
| Operatorの受入・差戻し・取消・Comment（`accept` / `reject` / `cancel` / `comments`、`*AsOperator`） | 移植する | Task詳細の操作。Task 33で非移植にした`acceptTaskAsOperator` / `rejectTaskAsOperator` / `cancelTaskAsOperator`を`TaskCoordinationService`へ戻し、Web APIから呼ぶ。Humanの受入・差戻しはAgentの自己受入禁止規則と独立（HumanはAgent Principalではない） |
| `AddStoryPage` / `EditStoryPage` / `EditTaskPage`（手動起票・編集・並べ替え・削除） | 後段で移植する | Execution section / Task詳細から遷移する画面。Outcome起点のStoryは`issue_story`（Manager）が作る前提のため、Human手動起票は閲覧・介入より後に移す。Outcome由来のStoryのsnapshot（Success Criteria・Constraints・Repository）はUIからも変更不可 |
| baseDir表示・Skill / Knowledge画面 | 移植しない | 概念自体を移植しない（「Project ID対応」「MCP tool統合方針」） |

Execution以外で本Storyに必要なHuman向けUI:

- **Grant**: `evaluator`（Task 35）と`runtime`（Task 31の暫定Role）の`GrantSection`をProject詳細に追加する。Task 35の実装記録にある「Web UIのGrant発行画面は`evaluator`を追加しない」は本決定で取り消す。`runtime` sectionはTask 37でRuntime Credentialの発行・rotation・取消UIへ置き換える。
- **Outcome詳細**: Execution Summary・Evidence参照（Task 34）、Evaluation履歴とCriterionごとの判定・根拠（Task 35）、それを根拠にしたDirection Decision（Task 36）を表示する。いずれも読取のみ（EvaluationやEvidenceの登録はAgent / RuntimeのMCPが正規入口）。
- **archived Project**: 既存方針どおり閲覧のみ。Grant・Operator操作・手動起票のボタンを出さず、Web APIもCONFLICTで拒否する。

### 移行順

1. **U1 Grant**: evaluator / runtime のGrantSection（Task 35の差し戻し対応で実装済み）。
2. **U2 閲覧**: Execution section（Story / Task一覧・最近の変更）、Task詳細（Comment・Change履歴）、Outcome詳細のExecution Summary / Evidence / Evaluation表示。Web APIはGETのみで、既存のExecution service・Direction use caseへ委譲する。
3. **U3 Human介入**: Task詳細での受入・差戻し・取消・Comment。
4. **U4 手動起票**: Story / Taskの作成・編集・並べ替え・取消。
5. **U5 認可の適用**: Human認証Story（Task 39〜43）の完了後、U2〜U4のWeb APIへProject Membershipの権限表（[step-6-human-auth-design.md](step-6-human-auth-design.md)「権限表」。閲覧はviewer、介入・手動起票はeditor）を適用する。それまでは既存Web APIと同じtrusted-local（匿名）で動く。
6. **U6 Credential管理**: Task 37でruntime Grant sectionをCredential管理UI（Agent・Runtime Credential section）へ置き換えた。

U2〜U4は現在のどのTaskの完了条件にも含まれていないため、Task 38（閉ループ検証）より前に実施するTaskの追加をManagerへ提案する（Task 30の作業コメントに記載）。

## Runtime event契約（Task 31・32の前提）

既存`runtime_event`テーブル（Direction、Task 25で導入済み。cursor/ack契約と取得入口はTask 31で実装済み）と、新規`change_log`テーブル（Execution、Wachaの`list_changes`と同じcursor方式）の2系統を維持する。

**Task 30当初設計からの変更**: 当初は「Ack/配送保証はCompassが持たず、Runtimeがcursorを保持する」としていたが、Task 31の完了条件（同じconsumerの再取得でack済みを未処理として返さない・再起動で欠落しない・retry可能と終端失敗の区別）はCompass側にconsumer単位の処理結果を永続化しないと満たせない。そのため`runtime_event`だけはconsumer単位のack（`runtime_event_delivery`）をCompassが持つよう変更した。Compassが持つのは「どのconsumerがどのイベントをどう処理したか」の記録だけで、配送のpush・lease・retry間隔・Agent起動は引き続き持たない。`change_log`は状態変化の監査・増分取得用で、処理の引受け単位ではないため当初どおりackを持たない。

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

### イベントpayload

全イベント共通の必須項目: `id`（イベントの一意ID。重複起動の判定キー）、`cursor`（全体で単調増加）、`version`（形式version。現在`1`。項目の意味を変えるときだけ上げ、Runtimeは未知のversionを`terminal_failure`にする）、`type`、`projectId`、`correlationId`、`occurredAt`。種類に関係しない項目は`null`で返し、項目自体は省略しない。

| type | 種類別の必須値（非null） | null固定 | correlationId | 起動するAgentに渡す値 |
| --- | --- | --- | --- | --- |
| `research_requested` | `researchRequestId` | `outcomeId` / `evaluationId` / `conclusion` | Research Requestの相関ID | Researcher: `projectId`・`researchRequestId`（`intentId`はproject_watchではnull） |
| `research_completed` | `researchRequestId`、`conclusion` | `outcomeId` / `evaluationId` | 同上 | Strategist: `projectId`・`intentId`・`researchRequestId`・`correlationId`・`version` |
| `outcome_confirmed` | `intentId`、`outcomeId` | `researchRequestId` / `evaluationId` / `conclusion` | `outcome:{outcomeId}` | Manager: `projectId`・`outcomeId`・`correlationId`（`issue_story`の`correlationId`にそのまま渡す） |
| `outcome_evaluated` | `intentId`、`outcomeId`、`evaluationId` | `researchRequestId` / `conclusion` | `outcome:{outcomeId}` | Strategist: `projectId`・`intentId`・`outcomeId`・`evaluationId`（Decisionの`evaluationId`に渡す） |

`change_log`の各Change（Wacha既存の`TASK_CLAIMED`等）は`cursor`・`projectId`・`type`・`entityId`（Story / Task等のID）・`principalId`・`claimId`・`payload`・`occurredAt`を持つ。Outcome由来のStoryとその配下Taskの変更にだけ、Task 34で付けた`outcomeId` / `correlationId`が付く（それ以外では項目自体が無い）。`list_changes`の`nextCursor`は返した末尾で、ackが無いため永続化して再開に使ってよい。

### consumer・ackと失敗分類（`runtime_event`）

- **consumer**はRuntimeのPrincipal（Bearerから解決。入力では受け取らない）。ackはconsumerごとに独立し、別consumerのackは互いに影響しない。同じconsumerを複数プロセスで共有する場合の排他（lease / visibility timeout）はCompassが持たない（Runtime側で1 consumer = 1 dispatcherにする）。
- **ackの結果**:
  - `processed`: Agentの起動を引き受けた、または起動不要と判断した。確定で、以後そのconsumerへ返さない。
  - `retryable_failure`: 今回は処理できず再試行してよい（Agent起動失敗、timeout、Compass / 外部の一時エラー）。次の取得でも返り続け、`retryCount`・`lastFailureReason`が付く。backoffと再試行上限はRuntimeが決め、上限到達時は`terminal_failure`でackする。
  - `terminal_failure`: 再試行しても成功しない（未知の`version`・`type`、payload不正、対象Grant取消・archivedなどCompassが恒久的に拒否する状態）。確定で、理由を残す。
- **Agent結果とackの対応**: 起動したAgentの後続コマンドがCompassの冪等な既存結果（同じ`requestKey`の再送・同じ`correlationId`のStory・同じ`evaluationId`のDecision）を返したときは、先行した処理が成功しているので`processed`。状態の変化で不要になった（`evaluation_not_latest`、`intent_not_active`、取消済みOutcome）ときも`processed`で、理由はRuntimeのログに残す。`UNAUTHENTICATED` / `FORBIDDEN`は資格情報・Grantの設定不備なので、ackせずRuntimeの運用者へ通知する（ackにもGrantが要るため）。
- **ackの冪等性（Task 31差し戻し対応で実装済み）**: ack入力に`attemptId`（Runtimeが1回の処理試行ごとに生成し、その試行の応答が失われた再送では同じ値を使う）を必須で追加する。`(consumer, eventId, attemptId)`が同じ再送は内容が同じなら状態を変えず`recorded: false`、異なる内容はCONFLICT。`retryCount`は異なる`attemptId`の`retryable_failure`だけを数える。確定済み（processed / terminal_failure）への別結果はCONFLICTのまま。
- **cursorの意味（Task 31差し戻し対応で実装済み）**: 取得応答の`nextCursor`は同じ取得処理内のページングにだけ使う。永続化して再開に使えるのは新設する`resumeCursor`（そのconsumerについて、それ以下のイベントがすべて確定済み（processed / terminal_failure）である最大のcursor）だけとする。`resumeCursor`は未確定（未ack・retryable_failure）のイベントを追い越さないので、Runtimeの再起動後に`afterCursor=resumeCursor`で取得すれば欠落しない。`afterCursor`を省略した取得も欠落しない（先頭から未確定だけを返す）。

### timeout・重複・順序逆転・再起動の回復規則

| 事象 | 規則 |
| --- | --- |
| 取得応答の消失 | 取得は読取専用。同じ`afterCursor`で再取得すれば同じ未確定イベントが返る |
| ack応答の消失 | 同じ`attemptId`で再送する（上記）。状態は変わらない |
| Agent実行のtimeout | Compassはleaseを持たないため、Runtimeが判断して`retryable_failure`をack（新しい`attemptId`）し、再起動する。先のAgentが遅れて完了しても、後続コマンドの冪等キーで二重作成されない |
| 重複配送・重複起動 | 下流のコマンドが冪等キーを持つことで収束させる: Research結果は`requestKey`、Outcome / Decisionは`requestKey`と`evaluationId`の部分unique（1 Evaluation = 1 Decision）、Storyは`(project_id, correlation_id)`、Outcome handoffのTaskは`(story_id, task_key)`（下記）、Evaluationは`(project_id, request_key)`、Evidence還流は`(outcome, kind, uri, version_hash)` |
| 順序逆転 | Runtimeは同一Projectのイベントを並列に処理してよい。各コマンドは実行時点の状態を検査するため、古いイベントからの操作はCONFLICT（`evaluation_not_latest`、`intent_not_active`等）になり、上記のとおり`processed`で閉じる。Evidence還流は古い`changeCursor`でも状態を巻き戻さない（Task 34） |
| Compass再起動 | `runtime_event`・`runtime_event_delivery`・`change_log`・`command_receipt`はDBに永続化され、再起動で変わらない。Runtimeは`resumeCursor`（runtime_event）と自分で保持したcursor（change_log）から再開する |
| Runtime / Agent再起動 | Runtimeは`resumeCursor`から再取得し、未確定イベントを再処理する。Agentは新しい`attemptId`で起動し、下流の冪等キーは決定的な値（相関ID・`task_key`・イベント由来の`requestKey`）を使うので、前回途中まで作ったEntityを再利用する |

### Outcome handoffのTask論理ID（Task 33差し戻し対応で実装する決定）

Storyは`correlationId`で二重作成を防げるが、Taskは`requestId`（`command_receipt`）だけで、Manager再起動後の別`requestId`では重複する。次の契約にする。

- `issue_task`に任意の`taskKey`（Story内で一意な論理ID。Managerが計画から決定的に付ける短い識別子）を追加し、`task`に`task_key`列と`(story_id, task_key)`の部分unique index（NULLは対象外）を持たせる。
- 相関ID付きStory（Outcome由来）配下のTaskでは`taskKey`を必須とする。同じ`taskKey`の再送は内容が同じなら既存Taskを返し（`requestId`が異なっても）、内容が異なればIDEMPOTENCY_CONFLICT。
- 手動起票（相関IDなしのStory）では`taskKey`は任意で、旧Wachaの`requestId`契約をそのまま維持する。
- Managerは再起動後、`list_tasks({ storyId })`で既存の`taskKey`を確認してから不足分だけを`issue_task`する（`agent/manager.md`に手順を書く）。

## 冪等性・相関ID・再起動時の回復規則

- Execution内の操作（claim/complete/review/accept等）は、Wachaの`requestId`＋`command_receipt`方式をそのまま使う（上記「idempotency方式の違い」参照）。
- DirectionからExecutionへのhandoff（Outcome確定 → Manager起動 → `issue_story`）は、`outcome:{outcomeId}`形式の決定的`correlationId` + `story`テーブルの`(project_id, correlation_id)` unique indexで、Runtimeの重複起動・`issue_story`の重複呼び出しのいずれでも二重Story作成を防ぐ。配下のTaskは`(story_id, task_key)`で同様に防ぐ（「Outcome handoffのTask論理ID」）。
- ExecutionからDirectionへの還流（Task 34）も、`change_log`の`cursor`を還流側が保持し、同じcursor範囲の再取込みでも重複しないよう、Task 34では、Outcomeごとに1行の要約を`execution_cursor`が進むときだけ上書きし、Evidenceを`(outcome, kind, uri, version)`で一意にして収束させた（「実装記録（Task 34）」）。
- サーバー再起動時は、`runtime_event`/`change_log`いずれも追記のみのテーブルであるため、再開位置（`runtime_event`は`resumeCursor`、`change_log`はRuntimeが保持するcursor）から再開すれば欠落なく再取得できる。CompassはRuntimeのプロセス生存やスケジュールを管理しない（kit/additional-doc.md §3, §27の責任分離どおり）。

## Task 31〜38への反映

- **Task 31（実装済み・差し戻し対応済み）**: `runtime_event`のcursor/ack付きWeb API/MCP入口を実装した。認可は暫定の`runtime` Role Grant（Task 37でRuntime Credential scopeへ置き換え）。`outcome_confirmed`はTask 33で追加した。差し戻し対応で「consumer・ackと失敗分類」のack `attemptId`（試行記録table `runtime_event_ack_attempt`）と`resumeCursor`を実装し、README・`agent/runtime.md`の再開案内を`resumeCursor`へ改めた。
- **Task 32（実装済み）**: `additional_research` Direction Decisionから追加Research Requestと`research_requested`イベントを作る確定経路。本Taskの設計変更は無し（既存のResearch集約の冪等性パターンを踏襲）。実装記録は`docs/research-decision-adr-design.md`の「追加Research判断のRequest・Runtimeイベント接続（Task 32）」。
- **Task 33（実装済み・差し戻し対応済み）**: 実装記録は本文書末尾の「実装記録（Task 33）」。差し戻し対応で「Outcome handoffのTask論理ID」（`taskKey`）を実装し、`agent/manager.md`に再起動後の手順を書いた。本Taskの「モジュール構成」「DB schema」「MCP tool統合方針」「Role/Instruction配置」に従い、旧Wacha Execution一式を移植する。あわせて`outcome_confirmed`イベントを`CreateOutcomeUseCase`/`DecideNextOutcomeUseCase`に追加し、`DirectionReferenceLookupPort`を実装し、`issue_story`の`outcomeId`拡張を実装する。`agent/role-policy.md`のマージ、README等のドキュメント更新もここで行う。
- **Task 34（実装済み）**: 実装記録は本文書末尾の「実装記録（Task 34）」。`ExecutionEvidencePort`の詳細（テーブル形状、増分取込みの単位）はTask内で確定し、書込ポートではなく読取専用の`ExecutionSummaryPort`にした。
- **Task 35〜36（実装済み）**: Outcome EvaluatorはDirection側のEntityであり、Executionとは、Task 34で還流したExecution SummaryとEvidence参照だけを介する。Task 35の差し戻し対応で「Web UIの配置と移行順」のU1（evaluator / runtimeのGrantSection）を実装した。
- **Web UI U2〜U4**: Task 45（U2 閲覧、実装済み。本文書末尾の「実装記録（Task 45）」）・Task 46（U3 Human介入、実装済み。本文書末尾の「実装記録（Task 46）」）・Task 47（U4 手動起票、未実装）で扱う。
- **Task 37（実装済み）**: 本Taskで「暫定trusted-local」とした認証を、Agent/Runtime向け不透明Credentialへ置き換えた。`runtime_event`（`runtime:event:read` / `ack`）と`change_log`（`list_changes`の`execution:change:read`）双方が対象。実装記録は`docs/step-6-human-auth-design.md`の「実装記録（Task 37）」。
- **Task 38（実装済み）**: 本Taskで決めたRuntime event契約・冪等性規則を、統合Compass serverと外部Runtimeの最小test harnessで閉ループとして自動検証した。実装記録は本文書末尾の「実装記録（Task 38）」。

## 未接続・未実装・対象外（Task 30時点の記録。現在の状況は「実装記録（Task 33）」以降）

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
- **Taskの論理ID（差し戻し対応）**: 「Outcome handoffのTask論理ID」のとおり、`issue_task`に任意の`taskKey`（空白不可・200文字以内、`storyId`必須）を追加し、`task.task_key`列と`task_story_key_idx`（`(story_id, task_key)`、`task_key is not null`の部分unique index）を持たせた。既存DBには`initializeSchema`が列とindexを冪等に追加し、既存Taskは`task_key = NULL`（旧Wachaの`requestId`契約）のまま残る。相関ID付きStory配下では`taskKey`が無いとINVALID_INPUT。同じ`taskKey`の再送はtitle・descriptionが同じなら（`requestId`・Principalが異なっても）既存Taskを返し、異なればIDEMPOTENCY_CONFLICT。既存Taskの状態（取消済み等）は問わず、そのまま返す。`list_tasks`・`issue_task`の結果と`TASK_CREATED`のChange payloadに`taskKey`を含める。`edit_task`で内容を変えた後に元の内容で再送するとIDEMPOTENCY_CONFLICTになるため、Managerは再起動後に`list_tasks({ storyId })`で既存の`taskKey`を確認してから不足分だけを起票する。
- **失敗の区別**: Bearerなし=UNAUTHENTICATED、Grant無し・存在しないProject=FORBIDDEN（存在を漏らさない）、別ProjectのOutcome / 存在しないOutcome・Repository=NOT_FOUND、取消済みOutcome・archived Project=CONFLICT、入力不正=INVALID_INPUT。いずれもStoryを部分的に残さない。
- **archived Project**: 設計文書には無かったが、Step 5の「archivedでは新しい活動を始めない」に合わせ、`issue_story` / `issue_task` / `claim_task`を`ProjectArchivedError`（CONFLICT）で拒否する。参照、既に`doing`のTaskの完了・review・受入は妨げない。

### 境界

Executionのコードが読み書きするtableは、Execution自身のtableと共有の根（`project`の状態確認、`project_grant`のRole検査。どちらも読むだけ）に限る。Directionのtable・Repository・use case・modelはimportせず、`DirectionReferenceLookupPort`だけを通る。Directionのコードは、Executionのtable・serviceを直接使わない（配線する`createApplicationServices.ts`とMCP公開層を除く）。`test/executionBoundary.test.ts`がソースを静的に走査して検証する。別Wacha server・localhost HTTP / MCPは使わない（同一プロセス内のモジュール呼び出し）。

### 実装済み・未接続・未検証

- 実装済み: 上記。検証: 旧Wachaのservice回帰テストの移植（19件）、統一`/mcp`経由（実MCP SDK clientでの実server起動を含む手動確認）、handoffの冪等性・snapshot・失敗分類・並行・再起動（Story・Taskの両方。応答消失後の別`requestId`、server再起動後の別Principal Managerによるやり直し、`task_key`導入前DBの移行を含む）、`runtime_event`マイグレーション、境界。
- 未接続: 外部Runtimeによる`outcome_confirmed`の取得とManagerの起動（テスト内のMCP呼び出しがRuntimeを模す）。Execution → Directionの還流の起動（Task 34で入口は実装済み。起動するRuntimeは未接続）、Evaluationの起動と遷移（Task 35で保存、Task 36で再計画・Intent完了への遷移を実装。起動するRuntimeは未接続）、不透明Credential（Task 37。認証は引き続きtrusted-local）。
- 対象外・移植せず: `list_projects` / Skill / Knowledge。旧WachaのWeb UI（Project Activity・Task drawer等）とOperator操作は、Task 33時点では未移植だったが、「Web UIの配置と移行順」で移植範囲と順序を確定した（U2〜U4、未実装）。
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
- 未接続: Change取得から還流を起動する外部Runtime（テスト内の呼び出しがRuntimeを模す）。EvidenceのURI・commit SHAを実GitHub等で実在確認しないこと（形式の検証のみ。Repositoryとの対応検証も行っていない）。Task 34時点ではEvaluationは未実装だった（保存はTask 35、再計画・Intent完了への遷移はTask 36で実装。Evaluatorを起動するRuntimeは未接続）。不透明Credential（認証はtrusted-localのまま）。
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
- **Strategist / Researcherの`unavailable`は変えない**。`evaluation`を外すのは、Evaluatorが実際に接続され、Evaluationを含むStrategist ContextをTask 36で提供した後にする。Web UIのGrant発行画面は`evaluator`を追加しない（`runtime`と同じ扱い。Web APIとCLIは対応）。※この選択は「Web UIの配置と移行順」U1で取り消した。Task 35の差し戻し対応で、Project詳細にevaluator / runtimeのGrantSection（既存のStrategist等と同じ発行・一覧・取消、archivedでは一覧のみ）を追加済み。Human向けのEvaluation閲覧用Web API / UIは持たない（U2でOutcome詳細に追加する予定。未実装）。

### 実装済み・未接続・未検証

- 実装済み: 上記。`test/outcomeEvaluation.test.ts`が、実MCP経由の保存・導出・根拠の検証・網羅性・冪等性（並び順違い・評価後のExecution進行・ファイルDBの再起動）・拒否（Role・別Project・取消済みGrant・Bearerなし）・状態（未還流・取消済み・archived）・Outcome / Execution / Project / Intentを変更できないこと・`unavailable`の維持を確認する。
- 未接続: Evaluatorの起動（`outcome_confirmed`のように、Evaluation用のRuntime eventは作っていない）。Evaluationからの再計画・次のOutcome判断・Intent完了（Task 36）。Evidence参照先を実際に取得して観測する処理（Evaluatorの責務で、Compassは参照の形式しか見ない）。不透明Credential（認証はtrusted-localのまま）。
- 画面検証（最終受入の差し戻し対応）: trusted-localの実server（空DB）とheadless Chrome（DevTools Protocol。検証scriptはリポジトリに含めない）で67項目を確認した。Evaluator GrantSectionの発行・重複・一覧・取消（確認パネル・やめる）と成功/失敗通知（`role=status`・エラー要約へのfocus・入力保持）、keyboardだけの操作とfocus表示、owner / administratorだけに発行・取消の導線が出てeditor / viewerは一覧のみ（APIも`403`）、未所属は`404`、archivedは一覧のみ（APIは`409`）、通常幅と375px幅でsectionが画面内に収まること。Runtimeは、Task 37でruntime GrantSectionがCredential管理へ置き換わったため、「Agent・Runtime Credential」でRuntime Credentialの発行・一覧・取消とscope未選択の失敗通知を確認した（archivedでは発行・rotationが消え、取消は残る。Task 37の設計どおり）。観察: 取消後は行が消えるためfocusが`body`へ戻る（既存GrantRow共通）。375px幅ではMember節の招待フォーム（Role選択肢の長い文言）が横にはみ出す（Task 43の範囲）。
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

## 実装記録（Task 38）

空DBの統合Compass serverに対し、Web UIと同じWeb API（Human: Google OIDC Session）と統一`/mcp`（Agent / Runtime: Task 37の不透明Credential）だけを使い、Intent → Research → Outcome → Execution → Evaluation → 再計画 → Intent完了を一周させる自動検証を`test/lv6ClosedLoop.test.ts`に置いた。外部Runtimeと各Agentは`test/support/lv6Runtime.ts`で、Compassの外側のプロセスとして`src/`をimportせず（同テストが静的に検査）、実MCP SDK clientとBearerだけで操作する。

### 初期選択と理由

- **serverは`src/server.ts`と同じ手順で組み立てる**（設定読込 → schema → services → bootstrap検査 → `createApp` → 同一portで`serve`）。Google OIDCのfetchと時刻源だけを差し替える（Claim期限切れを待たずに進めるため）。`src/server.ts`自体を1コマンドで空DBから起動し、同一portで`/health`・`/api`・Web UI（build済みのとき）・統一`/mcp`のDirection / Execution toolsを提供することは、別のテストで子プロセスとして確認する。
- **Humanの操作は初期設定だけ**（OIDCログイン、Project・Intent作成、Agent GrantとAgent / Runtime Credentialの発行）。以降はHumanの途中承認・CLI・直接DB操作なしで進む。DBはassertの観測にだけ読む。
- **Agentは決定的なscript**（LLMではない）。Researcher → Strategist（`research_completed`で`decide_next_outcome`）→ Manager（`outcome_confirmed`で`issue_story`・`taskKey`付き`issue_task`）→ Worker / Reviewer（1回目はreject、2回目にreviewed）→ Manager受入 → Runtimeが`list_changes`の増分から`record_execution_evidence`でPR・CIのEvidence参照を還流 → Evaluator → Strategist（`outcome_evaluated`で追加Researchまたは`intent_complete`）。
- **筋書き**: 最初のOutcomeは本番dashboardでしか観測できない基準を持ち、Evaluationは`insufficient_evidence`になる → 追加Research → CIで観測できる基準に直した次のOutcome → `achieved` → Intent完了。

### 検証する障害系

- **insufficient_evidence**: 最初のOutcomeのEvaluationが推測で成功・失敗にならず、追加Researchの根拠になる。
- **Execution reject**: 各TaskをReviewerが1回差し戻し、Workerが出し直す（`TASK_REJECTED`が2件）。
- **timeout**: Managerが`issue_story`後にtimeout → `retryable_failure`でack → 次の試行（新しい`attemptId`）で同じStoryへ収束。Workerが応答しなくなりClaim期限が切れる → 別のClaimで完了（`CLAIM_EXPIRED`）。
- **レスポンス消失**: `ack_runtime_event`・`issue_story`・`record_outcome_evaluation`は、requestが届いた後に応答を失い、同じ入力で再送して同じ結果を得る。
- **重複配送**: 最初の`research_completed`でStrategistを並行に2回起動しても、Outcome・Decisionは1件。
- **順序逆転**: 1周の中で新しいイベントから処理する。古いEvaluationを根拠にした判断は`CONFLICT`、古い`changeCursor`の還流は`staleInput`で状態を変えない。
- **server / Runtime再起動**: 2つ目の`outcome_confirmed`でManager完了後・ack前にRuntimeとserverを停止し、同じDB fileで再起動する。Runtimeは永続化した`resumeCursor` / `changeCursor`だけを引き継ぎ、未ackのイベントを再取得して同じStoryへ収束する。
- **二重なし・欠落なし**: Story・Task・Outcome・Evaluation・Direction Decision・Research Requestの件数、全`runtime_event`がこのconsumerで`processed`に確定したこと、相関ID（`intent:` / `decision:` / `outcome:`）でResearch → Outcome → Story / Change → Evaluation → 判断を辿れることを確認する。
- **境界**: Direction / Executionが相互のRepository・tableを直接使わないこと、別Wacha server・内部loopbackを使わないことは`test/executionBoundary.test.ts`（Task 33）で確認する。

### 実装済み・未接続・未検証

- 実装済み: 上記の自動検証。`src/`の変更は無い（Task 31〜37の契約で閉ループが完走した）。
- 未接続: 実際の外部Runtime（イベントのpolling・Agentプロセスの起動・再試行の管理）とLLM Agent。Evidence参照先（GitHub・CI）の実取得。実Google（OIDC fixtureを本番の`GoogleOidcIdentityProvider`へ注入）。Human向けのExecution手動起票UI（U4、Task 47。閲覧のU2はTask 45、介入のU3はTask 46で実装済み）。
- 未検証: 本テストはCompass側の契約（イベント・ack・冪等性・状態遷移・認可）で閉ループが完走することの確認で、LLM Agentによる自律運転（Lv6）の実証ではない。テストのharnessはloopbackの`127.0.0.1`でserverへ接続するが、これは外部Runtimeの役割を模すためで、Direction / Execution間の連携には使っていない。loopbackへのlistenが禁止された環境では理由付きでskipする。

## 実装記録（Task 45）

「Web UIの配置と移行順」のU2（閲覧）を実装した。U5（Membership認可の適用）もこの範囲のWeb APIへ同時に適用した（Human認証Storyが完了済みのため）。

### 実装した範囲

- Web API（すべてGET。Session必須、Membershipのviewer以上＝`project.read`。未所属・存在しないProjectは`404`、archived Projectも参照できる）:
  - `GET /api/projects/:projectId/execution[?outcomeId=]`: Story（状態・Outcome・相関ID）とTask（状態・Claim（期限内だけ`activeClaim`、期限切れは`reclaimable`）・差戻し理由・更新時刻）、状態別件数。`outcomeId`を渡すと、そのOutcomeを参照するStoryと配下のTaskだけを返す。
  - `GET /api/projects/:projectId/tasks/:taskId`: Task・所属Story・Comment・当該TaskのChange（古い順）。別ProjectのTask IDは`404`。
  - `GET /api/projects/:projectId/changes[?beforeCursor=&limit=]`: 「最近の変更」。新しい順に`limit`件（既定50、1〜100）を返し、さらに古い変更があれば`nextCursor`（次の`beforeCursor`）、無ければ`null`。不正な値は`400 VALIDATION_ERROR`（path `beforeCursor` / `limit`）。MCP `list_changes`（古い順・`afterCursor`）と同じChange Logで、相関付くChangeには`outcomeId` / `correlationId`が付く。
  - `GET /api/projects/:projectId/outcomes/:outcomeId/evaluations`: OutcomeのEvaluation履歴（新しい順）。Direction側のuse case（`ListOutcomeEvaluationsUseCase`）。
- Web UI（`src/frontend/features/execution`）: Project詳細の「Execution」section（Story・Task一覧、最近の変更と「さらに古い変更」）、Task詳細`/projects/:projectId/tasks/:taskId`（概要・差戻し理由・Comment・変更履歴）、Outcome詳細の「Execution・評価」section（そのOutcomeのStory・Task、還流したSummaryとEvidence参照、CriterionごとのEvaluationと総合結果、そのEvaluationを`evaluationId`で根拠にしたDirection Decision）。いずれも参照専用で、書込の導線を持たない。

### 初期選択と理由

- Execution側の読取は`TaskCoordinationService`に、Role Grantを検査しない`*OfProject`の読取メソッド（`listStoriesOfProject`・`listTasksOfProject`・`getTaskDetailOfProject`・`listRecentChangesOfProject`）と`projectExists`を足し、`src/application/service/execution/ExecutionReadUseCases.ts`のuse caseからだけ呼ぶ。Agent向けのMCP toolはGrant必須の既存メソッドのままで、`availableFor`（Agent PrincipalのRoleに依存）はHuman向けに公開しない。use caseはExecution側に置き、DirectionのRepositoryをimportしない（`test/executionBoundary.test.ts`）。
- 「最近の変更」は、Humanが最新から辿れるよう新しい順・`beforeCursor`にした。MCPの`afterCursor`（増分取得）は変えない。
- Outcome詳細の閉ループ表示は、各所有側のWeb API（Execution一覧・Execution Summary・Evaluation・Direction Decision）をUIで組み合わせる。Direction / Executionのapplication層は互いのRepositoryを読まない。現在地は「Execution未接続（Storyなし）」「Execution中（未還流）」「未評価（還流済み）」「評価済み: 総合結果」を区別し、Executionの`accepted`を達成と表示しない。還流済みでEvidence参照が0件なら「Evidence不足」と表示する。
- Change LogにComment追加の種別は無い（Commentは`task_comment`だけに残る）ため、Task詳細ではCommentとChangeを別に表示する。

### 実装済み・未接続・未検証

- 実装済み: 上記のWeb API・UI。`test/executionWebRead.test.ts`（一覧・絞込・Task詳細・別Project `404`・cursor・不正query `400`・未所属`404`・administrator / editor / viewer・archived・Session無し`401`）、`test/outcomeEvaluation.test.ts`（Human向けEvaluation API）、`test/executionUi.test.ts`（表示用の変換）。
- 画面検証: trusted-localの実server（空DB。Story・Task・Claim・Comment・差戻し・受入・Evidence還流・Evaluation・Decisionは実MCPで作成）とheadless Chrome（DevTools Protocol。検証scriptはリポジトリに含めない）で、1280px・375px幅で計53項目（375px幅の参考記録1項目を含む）を確認した。Project詳細のExecution section（Story・Task・状態・担当・Claim期限・相関ID）、最近の変更（20件表示、「さらに古い変更」をTab・Enterだけで追加読込、新しい順で重複なし、最後のページでは案内文へfocusを移す）、Task詳細をkeyboardで開けること（focus表示あり）、Comment・差戻し理由・変更履歴、Outcome詳細の評価結果・Evidence・Criterion・Decisionと、未接続・未還流・未評価の区別、空Projectのempty表示、別ProjectのTask・未所属Projectのerror表示、archived Projectの閲覧、loading（`role=status`）とAPI失敗時のerror（`role=alert`）表示、Task詳細・Outcome詳細が375px幅で横スクロールしないこと。Project詳細の375px幅の横スクロールはMember招待フォームの既知の問題（Task 43の範囲。別Taskで扱う）で、Execution sectionの要素は画面内に収まる。検証中に見つけた長い英数字の折返し不足と「担当 担当なし」の重複表示は修正した。
- 未実装: 手動起票・編集（Task 47）。Human介入（受入・差戻し・取消・Comment）はTask 46で実装した。

## 実装記録（Task 46）

「Web UIの配置と移行順」のU3（Human介入）を実装した。U5（Membership認可）も同時に適用した。

### 実装した範囲

- Web API（Session・CSRF必須。Membershipのeditor以上＝権限表の`execution.intervene`）:
  - `POST /api/projects/:projectId/tasks/:taskId/accept`: `in_review` / `wait_accept`のTaskを受け入れる。受入Claimの取得（`TASK_CLAIMED`、`claimCommand: claim_acceptance`。`in_review`から直接受け入れた場合は`path: operator_direct_review`、Reviewer承認後は`reviewer_approved`）と受入（`TASK_ACCEPTED`）を同じtransactionで行い、Storyの全Taskが終端になればAgentの受入と同じく`STORY_COMPLETED`を残す。
  - `POST .../reject`（`{ reason }`必須）: `in_review` / `wait_accept`を`rejected`へ。差戻し理由はTaskとChangeに残る。
  - `POST .../cancel`（`{ reason }`必須）: `todo` / `doing`を`canceled`へ。有効なAgent Claimは同じtransactionで解放し（`claimId`をChangeに残す）、古い`claimId`での以後の操作は拒否される。
  - `POST .../comments`（`{ body }`必須）: `task_comment`に`claimId: null`で残す。どの状態のTaskにも追加できる。
- application層: `src/application/service/execution/ExecutionOperatorUseCases.ts`（入力検証、CoordinationErrorの変換）→ `TaskCoordinationService`の`acceptTaskAsOperator` / `rejectTaskAsOperator` / `cancelTaskAsOperator` / `addTaskCommentAsOperator`。Human側の入口は`HumanOperatorUseCase`（`HumanProjectUseCases.ts`）で、Membershipの認可の後、操作者を`humanOperatorPrincipalId(actor)`（`human:{humanUserId}`）として委譲する。
- Web UI: Task詳細（`/projects/:projectId/tasks/:taskId`）に、状態に応じた「受け入れる」「差し戻す」「Taskを取消」と確認パネル（差戻し・取消は理由必須）、Comment入力を追加した。viewerとarchived Projectには導線を出さない（archivedは案内文を出す）。成功は`role=status`の通知（操作後は通知へfocus）、失敗は`role=alert`で入力を残す。Change・Commentの`human:`はMemberの表示名で出す。

### 初期選択と理由

- **Human operatorのPrincipal**: Change Log・Commentの`principalId`は`human:{humanUserId}`、payloadの`actorRole`は`operator`（旧Wachaの`*AsOperator`と同じ語）。Execution側はHumanの型（domain model）をimportせず文字列だけを受け取る（`test/executionBoundary.test.ts`）。値は認証済みSessionからだけ導出し、request本文では受け取らない。
- **自己review / 自己受入の禁止との関係**: HumanはAgent Principalではないため、operatorの受入はManager Role検査と自己受入の禁止を行わない（設計表「Operatorの受入・差戻し…」どおり）。Agent用の`claim_acceptance`は同じ内部処理（`claimAcceptanceCore`）をmanagerとして通り、Role検査・自己受入の禁止・`manager_direct_review`の記録は変わらない。Humanは`complete_task`を行わないため、`latestCompleter`にHumanのPrincipalが入ることはない。
- **Agentとの競合**: 有効な（期限内の）Claimがある`in_review` / `wait_accept`は受入・差戻しを`409`（`conflict: CLAIM_CONFLICT`）で拒否し、先にClaimしたAgentを優先する。UIもClaim中は受入・差戻しを出さず理由を表示する。取消はManagerの`cancel_task`と同じくClaim中でも行える（方向転換で作業を止める例外対応のため）。期限切れのClaimは受入Claimの取得時に`CLAIM_EXPIRED`として記録してから進む。
- **Commentの記録**: Change Logに新しい種別を足さない（MCP `list_changes`の利用側・Runtimeの増分処理の契約を変えない）。Commentは`task_comment`に投稿者の`principalId`付きで残り、MCP `list_task_comments`でもAgentが読める。Claimに紐づかないため、Workerの`complete_task`が要求する作業記録にはならない。
- **HTTPの対応**: Execution serviceの`CoordinationError`はHuman向けWeb APIでは`409 CONFLICT`（`conflict`に元のコード。`CLAIM_CONFLICT` / `TASK_NOT_CLAIMABLE` / `INVALID_TASK_STATUS`）へ、`INVALID_INPUT`は`400 VALIDATION_ERROR`へ変換する。MCP側の応答は変えない。理由・本文は前後の空白を除いて必須（理由2000字、本文10000字まで）。
- **冪等性**: Web APIは`requestId`を取らない（旧WachaのOperator APIと同じ）。二重送信はUIの送信中表示で抑え、serverは状態遷移の検査で二重の遷移を`409`にする。
- **MCPへの非公開**: Human介入はWeb UI専用で、MCP toolを追加しない（AGENTS.md「Human向け管理操作をMCPへ無条件に公開しない」）。

### 実装済み・未接続・未検証

- 実装済み: 上記のWeb API・UI。`test/executionOperator.test.ts`（受入・差戻し・取消・Comment、operatorのChange、Storyの完了同期、理由必須・空白の拒否、Claim中・不正状態・二重受入の`409`とChange不変、取消によるClaimのfence、owner / administrator / editorの許可とviewer `403`・未所属`404`・Session無し`401`、別ProjectのTask・存在しないTaskの`404`、archivedの`409`、Agentの自己受入禁止の維持とMCPへ非公開）、`test/executionUi.test.ts`（導線の判定、Principalの表示）。
- 画面検証: trusted-localの実server（空DB。Story・Task・Claimは実MCPで作成、editor / viewerは招待で追加）とheadless Chrome（DevTools Protocol。検証scriptはリポジトリに含めない）で、1280px・375px幅で計45項目を確認した。状態ごとの導線（`in_review` / `wait_accept`は受入・差戻し、`todo` / `doing`は取消、Claim中は導線なしで理由表示）、keyboardだけの操作（Enterで確認パネル、受入の確認は見出しへ・差戻し / 取消は理由欄へfocus、Tabで「やめる」・確定、`aria-expanded`）、「やめる」で状態不変、空の理由はブラウザの必須検証・空白だけの理由は`role=alert`で入力保持、成功通知（`role=status`）へのfocusと操作後の導線の消去、変更履歴・CommentにHumanの表示名、空Commentのエラー要約へのfocusと`aria-invalid`、viewer・archived（owner）で導線なし、owner / editorで導線あり、画面を開いた後にAgentがClaimした競合で再読込を促す失敗通知と状態不変、両幅で横スクロールしないこと。検証中に、Task詳細の見出し下にある操作列・確認パネルのボタンが`.detail-hero .button`の余白で不揃いになるのを見つけ、CSSを修正した。
- 未実装: 手動起票・編集（Task 47）。

