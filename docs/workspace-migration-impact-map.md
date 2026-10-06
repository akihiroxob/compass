# Workspace移行 影響マップ

[ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md)を現行コードへ適用するときの、ファイル単位の変更先・互換期間・既存ID保全・データ変換・rollbackの確認点。[移行計画](architecture-migration-plan.md)のWorkspace Story 02〜12の各Taskは、着手時に本書の該当行を前提として確認する。記載は変更先の定義であり、実装の完了を意味しない。

調査対象はCompass `fcb16bc`のコードとテスト。Task番号は「S03-01」（Workspace Story 03のTask 01）の形で示す。

## 前提となる現況

- DBは単一SQLite file（`COMPASS_DB_PATH`、`server/src/bootstrap/database/createDatabase.ts`）で、`foreign_keys = ON`。table定義は各packageの`infrastructure/schema.ts`、初期化は`initialize*Schema.ts`をserverの`initializeSchema.ts`が順に呼ぶ（Direction → Work → Access → Activity）。
- migrationのversion管理はない。`create ... if not exists`と、`pragma_table_info`で列の有無を見る冪等な`ALTER TABLE ADD COLUMN`（`addProjectArchiveColumns`・`addDirectionDecisionEvaluationColumn`・Workの`active_role`）で既存DBへ追随する。server起動のたびに実行される。
- 全Context（Direction・Work・Access・Activity）のtableが`project_id`で`project.id`をFK参照し、`on delete cascade`を持つ（`direction_decision_synthesis`等の関連tableと`success_criterion`・`task_comment`・`task_claim`を除く）。
- Projectの戦略値（Mission等）を読むのは`DirectionReferenceLookupService`（Story作成時のConstraints snapshot）、`GetRoleContextUseCase`、`GetStrategistContextUseCase`（`project`全体）、Web UIの`ProjectDetailPage`・`ProjectListPage`・`projectForm.ts`。
- テストは48 fileがProject作成入力の`mission`を使う。Project作成の入力契約を変えるTaskはfixtureの追随を含む。

## SQLiteの制約から決まる作業

| 変更 | SQLiteで可能な方法 | 対象 | 該当Task |
| --- | --- | --- | --- |
| 列の追加 | `ADD COLUMN`。FK付きはnullableに限る（`NOT NULL`はdefaultが必要） | `project.workspace_id`、Direction各tableの`workspace_id` | S02-02、S03-01〜03 |
| `NOT NULL`化・CHECK制約の変更・主キーの変更 | table再作成（新table作成→全行コピー→rename）。`ALTER`ではできない | `activity`（scopeのCHECK）、`outcome_execution_summary`（PK）、`access_credential`（`project_id NOT NULL`） | S05-01、S06-03、S07-01 |
| FK付き列・index付き列の削除 | `DROP COLUMN`はFK・index・CHECKに使われる列を削除できない。indexを先に消し、FK付き`project_id`はtable再作成で除く | Direction各tableの`project_id` | S12-01 |

table再作成の共通確認点:

- `foreign_keys`をOFFにしてtransaction内で行い、最後に`pragma foreign_key_check`で違反0件を確認する。子tableのFK（例: `research_result.request_id`）と自己参照（`activity.corrects_activity_id`）の参照先IDを変えない。
- `autoincrement`の列（`activity.cursor`、`runtime_event.sequence`、`change_log.cursor`）は値をそのまま写し、`sqlite_sequence`を巻き戻さない。consumerのcursorが既存の位置で継続できることをテストする。
- 再作成後に同名のindex・partial unique indexを作り直す。server再起動で`initialize*Schema`を再実行しても同じ状態になる（冪等）ことを確認する。

## DB table

「段階」はADRの移行順（A: 追加・既存列維持、B: 読取切替、C: 書込切替、D: 未使用列の削除）。

### Organization（`packages/organization`へ移す）

| table | 現況 | 変更先 | Task | 既存ID・データ変換・確認点 |
| --- | --- | --- | --- | --- |
| `workspace`（新規） | — | id・name・mission・vision・status・archived_at・archive_reason・created_at・updated_at | S02-01 | Workspaceのarchiveは新規活動を拒否する。`project`のarchive列と同じ規則 |
| `workspace_principle` / `workspace_constraint`（新規） | — | `project_principle` / `project_constraint`と同じ`OrderedTextTable`形 | S02-01 | — |
| `project` | `mission NOT NULL`・vision・status・archive列。FKの参照先 | A: nullableの`workspace_id`（FK `workspace.id`）を追加。B/C: Mission等の読書きをWorkspaceへ。D: mission・visionを削除 | S02-02（A）、S02-03（B/C）、S12-01（D） | Project IDは変えない。C以降もD完了まで`mission NOT NULL`が残るため、Project作成時の値の扱い（Workspaceの値を写す等）をS02-03で決める。`workspace_id`の`NOT NULL`化は全行の補完後にtable再作成が必要で、参照FKが多いためS12-01で要否を判断する（それまではapplicationで必須を保証） |
| `project_principle` / `project_constraint` | Projectの子 | Workspaceの子へ値を写す。旧tableはDまで残す | S02-02（写す）、S12-01（削除） | 値と並び順（`sort_order`）を保つ |
| `project_repository_link` / `project_resource` | Projectの子 | 変更なし（所有packageだけ`packages/organization`へ） | S02-03 | Resource IDは`adr_handoff_request.repository_id`・Activityの`project_resource`参照・Storyの`repository_snapshot`から参照されるため変えない |

既存データの変換（S02-02）: `workspace_id`がnullのProjectごとに、Workspace作成（name・mission・vision・principles・constraintsを写す。statusはProjectに合わせる）と`project.workspace_id`の設定を同じtransactionで行う。条件を「`workspace_id`がnull」にすることで再実行・途中失敗後の再起動でも重複しない。archive済みProjectのWorkspaceもarchivedにするかはS02-02で決める（ADRはarchive済みWorkspace・Projectへdispatchしない）。

### Direction（Workspace scopeへ。S03）

| table | 現況のproject依存 | 変更先 | Task | 確認点 |
| --- | --- | --- | --- | --- |
| `intent` | `project_id` FK。`intent_one_active_per_project`（Projectにつき有効1件のpartial unique） | `workspace_id`。有効1件の制約をWorkspace単位にする | S03-01 | 移行直後は1 Workspace : 1 Projectなので一意性違反は起きない |
| `outcome` | `project_id` FK | `workspace_id`。Intentと同じWorkspaceを強制 | S03-01 | `success_criterion`は`outcome_id`だけで変更なし |
| `research_request` / `research_result` / `research_evidence_ref` / `research_finding` / `research_synthesis` | `project_id` FK。`(project_id, request_key)` unique、`research_finding_project_idx`等 | `workspace_id`。冪等キーの一意性をWorkspace単位へ | S03-02 | 関連table（`research_finding_evidence`・`research_finding_conflict`・`research_synthesis_finding`）はproject列なしで変更不要。`repository_file`等のEvidence参照はURIのまま |
| `direction_decision` | `project_id` FK、`(project_id, request_key)` unique | `workspace_id` | S03-02 | `direction_decision_synthesis` / `_finding`は変更不要。Intent Brief snapshot（JSON）は書き換えない |
| `adr_handoff_request` / `adr_reference` | `project_id` FK、`repository_id`はProjectのRepository | `workspace_id`を追加し、Project固有参照として`project_id`を残す（ADR: Project固有のDirectionレコードは`projectId`を明示的に持つ） | S03-02 | 冪等キーの一意性の単位（Workspace / Project）をS03-02で決める |
| `runtime_event` / `runtime_event_delivery` / `runtime_event_ack_attempt` | `project_id` FK、`runtime_event_project_sequence_idx` | `workspace_id` | S03-03 | `sequence`はtable全体の採番なので値を保てばconsumerのcursorはそのまま使える。`fetch_runtime_events` / `ack_runtime_event`の公開契約（Projectのcursor）の扱いはS03-04で決める（Orchestratorは`get_orchestration_state`を使い、これらに依存しない） |
| `outcome_execution_summary` | PK `outcome_id`（Outcomeにつき1行）、`project_id` | PKを`(outcome_id, project_id)`へ（table再作成）。`workspace_id`を追加 | S03-03（`workspace_id`）、S05-01（PK） | 既存行は元の`project_id`のまま1行として残す |
| `outcome_execution_evidence` | `project_id`、identity index `(outcome_id, kind, uri, version)` | Target Projectとして`project_id`を残し`workspace_id`を追加 | S03-03、S05-01 | 複数Projectが同じURIを報告した場合の一意性にProjectを含めるかをS05-01で決める |
| `outcome_evaluation` | `project_id` FK、`(project_id, request_key)` unique | `workspace_id`。評価snapshot（JSON）は全TargetのSummary / Evidenceを含む形へ | S03-03、S05-02 | 既存snapshotは書き換えない |
| `outcome_target_project`（新規） | — | `outcome_id`・`project_id`・`created_at`、`UNIQUE(outcome_id, project_id)` | S04-01 | 既存Outcomeは暗黙に元のProjectを対象としている。Targetを補わないと、移行後のOrchestratorが既存の有効Outcomeを「Targetなし」としてStrategistへ戻す。既存Outcomeへ元のProjectのTargetを1回だけ補うかをS04-01で決め、S08-02のdispatch規則と合わせて検証する |

既存行の変換（S03-01〜03）: 各行の`workspace_id`を`project.workspace_id`から補う。ADRに従い`project_id`列へWorkspace IDを保存しない。読取・書込をすべて`workspace_id`へ切り替えた後、旧`project_id`（Project固有参照として残す列を除く）とProject単位のindexをS12-01で除く。

### Work（Project scopeを維持）

| table | 現況 | 変更 | Task |
| --- | --- | --- | --- |
| `story` | `project_id` FK、`outcome_ref`（FKなし）、`correlation_id`、`story_project_correlation_idx`（`(project_id, correlation_id)` unique） | 変更なし。相関ID`outcome:{outcomeId}`の一意性がProject単位なので、1つのOutcomeからTarget Projectごとに別Storyを作れる | S04-03（作成時の検査のみ） |
| `task` / `task_comment` / `task_claim` / `change_log` / `command_receipt` | `project_id`（task・change_log）、Claim・状態遷移 | 変更なし | — |

Story ID・Task ID・Change Logのcursorは変換しない。回帰はS12-02で既存DBから検証する。

### Access

| table | 現況 | 変更先 | Task | 既存ID・データ変換・確認点 |
| --- | --- | --- | --- | --- |
| `project_grant` | PK `(project_id, principal_id, role)`。roleはCHECKなしでstrategist〜runtimeの7種 | `manager` / `worker` / `reviewer`は維持。`strategist` / `researcher` / `evaluator`は新`workspace_role_grant`へ | S06-02 | Direction Roleの既存Grantを所属Workspaceへ写す。移行後はProject scopeでDirection Roleを拒否するため、旧行の削除はS12-01まで残す。`runtime`のGrant（trusted-local）はWorkspace単位の状態Query（S08-01）の認可でどのscopeに置くかをS08-03で決める |
| `workspace_role_grant`（新規） | — | `(workspace_id, principal_id, role)` | S06-02 | GrantからProject権限を継承しない |
| `project_membership` / `project_invitation` | Project単位、最後のowner保護 | 変更なし | — | — |
| `workspace_membership`（新規） | — | Workspaceの閲覧・Direction管理・Project作成・member管理 | S06-01 | 移行Workspaceの初期memberを決める（既存Projectのownerを一度だけ写す、または`SQLiteHumanAccountRepository.adoptOrphanProjects`と同様にplatform ownerがowner不在のWorkspaceを引き取る）。実行時のRole継承にしない |
| `access_credential` | `project_id NOT NULL` FK、`kind`（agent / runtime）、`scopes_json`、`secret_hash` | scope kind（workspace / project）とscope IDを持つ形へ（`NOT NULL`の解除にtable再作成が必要） | S06-03 | Credential ID・`prefix`・`secret_hash`・期限・失効状態を保ち、既存のAgent / Runtime Credentialを再発行なしで使い続けられることをテストする |
| `human_user` / `human_identity` / `web_session` / `auth_login_attempt` | Project非依存 | 変更なし | — | — |

### Activity

| table | 現況 | 変更先 | Task | 確認点 |
| --- | --- | --- | --- | --- |
| `activity` | `scope in ('project', 'system')`のCHECK、`activity_scope_project_check`、`project_id` FK、`cursor` autoincrement、`activity_project_cursor_idx` | `workspace_id`を追加し、scopeに`workspace`を加えてADRの組合せ表をCHECKで強制（table再作成） | S07-01 | 既存のproject行へ`workspace_id`を補い、system行はnullのまま。cursor・id・`dedupe_key`・`corrects_activity_id`を保つ。過去行の再分類はしない |

Activityを書く経路は次の3つで、いずれも現行は`projectId`だけを渡し、`scope: project`でappendする。移行後のCHECKを入れると、これらが正しいscopeとIDを渡さない限り追記が失敗する。canonical Activityは状態変更と同じtransactionで追記するため、失敗は状態変更そのものを巻き戻す（Story / Taskの起票・完了・レビュー・受入・差戻し・取消、Direction操作、Project archiveが失敗する）。

| 経路 | 現行の書込 | 同じtransactionの内容 | 移行後のscope |
| --- | --- | --- | --- |
| Work由来のcanonical Activity | `server/src/infrastructure/repository/contextAdapters.ts`の`workChangeActivityObserver`がChange（`project_id`のみ）を`WorkChangeFact`へ変換し、`packages/activity/src/application/canonicalWorkActivity.ts`の`recordCanonicalWorkActivity`が`projectId`でappend | `packages/work/src/infrastructure/KyselyWorkStore.ts`のChange Log追記直後に`changeObserver`を呼ぶ | project（`workspaceId`・`projectId`） |
| Direction由来のcanonical Activity | `contextAdapters.ts`の`directionChangeActivityObserver`が`DirectionChangeNotice`（次節）を`canonicalDirectionActivity.ts`の`recordCanonicalDirectionActivity`へ渡す | Directionの状態変更 | workspace（`workspaceId`のみ）。`project_archived`だけはproject |
| 明示記録（`record_activity`・Web API） | `packages/activity/src/application/ActivityUseCases.ts`の`RecordActivityUseCase`が`ActivityProjectReader`（`contextAdapters.ts`の`activityProjectReader`）でProject状態を読みappend | 記録のみ | project。workspace scopeの記録はS07-02 |

#### Directionの状態変更通知（`DirectionChangeNotice`）

`packages/direction/src/infrastructure/directionChange.ts`の`DirectionChangeNotice`は`projectId`を必須に持ち、次の通知元が書込と同じtransactionで送る。Directionの記録がWorkspace所有になると、Workspaceに複数Projectが所属するためProjectを一意に選べない。通知はProjectを経由せず、所有scopeのIDを持つ契約に変える。

| 通知の種類 | 通知元（`packages/direction/src/infrastructure/`） | 現行の`projectId`の出所 | 変更後の契約 | 切替Task |
| --- | --- | --- | --- | --- |
| `intent_created` / `intent_abandoned` | `SQLiteIntentRepository.ts` | 引数の`projectId` | `workspaceId` | S03-01 |
| `outcome_confirmed` / `outcome_cancelled` | `outcomeRecord.ts`の`insertOutcomeRow`（`SQLiteOutcomeRepository.ts`・`SQLiteDirectionDecisionRepository.ts`から）、`SQLiteOutcomeRepository.ts`（取消） | 引数の`projectId` | `workspaceId` | S03-01 |
| `research_requested` / `research_closed` | `researchRequestRecord.ts`の`insertResearchRequest`（`SQLiteResearchRepository.ts`・`SQLiteDirectionDecisionRepository.ts`から）、`SQLiteResearchRepository.ts` | 引数の`projectId` | `workspaceId` | S03-02 |
| `decision_recorded` | `SQLiteDirectionDecisionRepository.ts`の`notifyRecorded` | `decision.projectId` | `workspaceId` | S03-02 |
| `outcome_evaluated` | `SQLiteOutcomeEvaluationRepository.ts` | 引数の`projectId` | `workspaceId` | S03-03 |
| `project_archived` | `SQLiteProjectRepository.ts`の`archive` | archiveしたProject | Directionの通知から外し、organizationのProject archiveの通知として`projectId`と所属`workspaceId`を持つ | S02-03（organizationへ移す）、S07-01（`workspaceId`を渡す） |

Activity側の受け口は`canonicalDirectionActivity.ts`の`DirectionChangeFact`（`projectId`）。Activityは`DirectionChangeNotice`に依存しないため、serverのobserverが変換する現行の形を保つ。

#### 切替の順序

S07-01の完了条件とADRどおり、S07-01でDirectionのcanonical Activityをworkspace scopeへ切り替える（S07-02へ延期しない）。通知の切替（S03-01〜03）とActivityの切替（S07-01）の順序で次が決まる。

- S03で通知が`workspaceId`だけになった時点で、Activityにworkspace scopeが無いと記録先のProjectを決められない（推測すると誤ったProjectの履歴になり、失敗させるとDirection操作がrollbackする）。そのためS07-01（workspace scopeの導入とDirection canonical Activityの切替）を、S03-01の通知切替より前に完了させる
- S07-01の時点ではDirectionの記録はまだProject所有なので、通知の`projectId`はその記録を所有するProjectを一意に示す。`directionChangeActivityObserver`は同じexecutorでorganizationのProject readerから所属Workspace IDを解決し、`workspaceId`だけを持つworkspace scopeでappendする。S07-01に必要なのはS02-02の補完（全Projectの`workspace_id`）とS02-03のProject readerで、Story 03は不要
- S03-01〜03では、上表の通知元ごとに`projectId`を`workspaceId`へ置き換える。置き換え途中は通知を「`workspaceId`を持つ」か「`projectId`を持つ（未切替の通知元）」かの判別可能な形にし、observerは前者をそのまま使い、後者だけProjectから解決する。S03-03の完了時に`projectId`の形を除く。Directionがorganizationのtableを直接読んで解決する形にはしない
- `project_archived`は、S02-03でorganizationへ移した後もproject scopeのActivity（`dedupe_key`は`direction_change:project_archived:{projectId}`のまま）とし、S07-01で所属Workspace IDを持たせる。`canonicalDirectionActivity.ts`の`directionActivities`から外す時期はS02-03

WachaのS07-01は前提を「Story 02・03」としている。上の順序に合わせてS07-01をS03-01より前に置くか、S03-01へActivityの切替を含めるかは、Task前提・境界の変更としてManagerが決める。決まるまでS03-01の通知切替に着手しない。

#### project scopeの経路

- Workは`workspace_id`を持たない（Project scopeのまま）。Change Logや`WorkChangeNotice`へ`workspace_id`を足さず、serverの`workChangeActivityObserver`が同じexecutor（同じtransaction）でorganizationのProject readerから所属Workspace IDを解決して`WorkChangeFact`に渡す。Activityはprojectのtableを直接読まない現行の境界を保つ
- `RecordActivityUseCase`は`ActivityProjectState`に所属Workspace IDを加えて受け取り、appendに渡す
- `workspace_id`を解決できないProject（S02-02の補完漏れ）は、CHECK違反として状態変更ごと失敗させる。黙ってsystem scopeやnullへ落とさない。S02-02の補完がS07-01の前提であることを着手時に確認する

#### 参照への影響

S07-01以降に作られるDirectionのActivityはProject Activityの一覧（`list_activities`・`/api/projects/:projectId/activities`・Web UIの`features/activity/`・`GetRoleContextUseCase`の最近のProject Activity）に出なくなる。S07-01ではworkspace scopeを読むapplicationのQueryまでを用意し、認可付きの公開入口（S07-02）とRole Context（S07-03）は間を空けずに続ける。S07-01以前のDirectionのActivityはproject scopeのまま残す（ADRの「過去のActivityの再分類は必須にしない」）。

#### 回帰

- 既存: `server/tests/activity.test.ts`の「Workの重要な状態変更は同じtransactionでcanonical Activityになり、再送・Claim操作では増えない」「Directionの重要な状態変更は同じtransactionで操作者付きのcanonical Activityになり…」「Agentはsummary必須…」と、`server/tests/execution*.test.ts`のStory / Task操作を移行後schemaで実行する
- 追加: 2つのProject（A・B）が所属するWorkspaceで、移行後schemaに対し次を確認する
  - Direction変更（Intent作成・Outcome確定・Research・Decision・Evaluation）: workspace scope、`workspace_id`が当該Workspace、`project_id`がnull。AにもBにもProject Activityが作られない
  - Project Aのarchive: project scope、`project_id`がA、`workspace_id`が当該Workspace。Bの履歴に出ない
  - Project BのWork状態変更: project scope、`project_id`がB、`workspace_id`が当該Workspace
  - それぞれでActivityの追記を失敗させると、Direction操作・archive・Work状態変更が同じtransactionで巻き戻る（原子性）
  - S03の切替途中（`projectId`の通知と`workspaceId`の通知が混在）でも同じ結果になる

## applicationとpackage

| 対象（現行ファイル） | project依存 | 変更先 | Task |
| --- | --- | --- | --- |
| `packages/direction/src/domain/Project.ts`・`ProjectRepository.ts`、`infrastructure/SQLiteProjectRepository.ts`・`isProjectArchived.ts`・`listProjectIdsInCreationOrder.ts`、`application/CreateProjectUseCase.ts`・`UpdateProjectUseCase.ts`・`ArchiveProjectUseCase.ts`・`GetProjectUseCase.ts`・`ListProjectsUseCase.ts`・`projectSchema.ts`、`error/ProjectArchivedError.ts` | Project本体 | `packages/organization`へ移し、Workspaceを加える。Direction・Access・Work・Activityが使うProject状態の読取（`ProjectStateReader`・`ActivityProjectReader`・WorkStoreの`projects`）はorganizationの実装に差し替える | S02-01、S02-03 |
| `SQLiteProjectRepository`のProject作成時の初期owner Membership書込（`projectOwnerMembershipWriter`経由） | 同一transactionの原子性 | organization移動後も同じtransactionで書く | S02-03 |
| `packages/direction/src/domain/*`（Intent・Outcome・Research・DirectionDecision・AdrHandoff・RuntimeEvent・OutcomeExecution・OutcomeEvaluation と各Repository） | `projectId` field・引数 | `workspaceId`へ。Project固有参照（ADR handoff / reference、Execution Summary / Evidence）は`projectId`を併せ持つ | S03-01〜03 |
| `packages/direction/src/application/*UseCase.ts`（大半が`projectRepository`を使う）、`*Rejection.ts` | Project存在・archive検査、`requireRole(principal, projectId, role)` | Workspace存在・archive検査、Workspace scopeの認可 | S03-01〜04 |
| `application/port/DirectionAuthorizationPort.ts` | `requireRole` / `requireScope`が`projectId` | `workspaceId`へ。実装はAccessの`WorkspaceRoleGrant`・Workspace Credential | S03-04、S06-02 |
| `application/port/ExecutionSummaryPort.ts`、Workの`ExecutionSummaryService.ts` | `getOutcomeExecutionSummary(projectId, outcomeId)` | 形は維持し、Target Projectごとに呼ぶ | S05-01 |
| `application/DirectionReferenceLookupService.ts`、Workの`port/DirectionReferenceLookupPort.ts` | `findByIdInProject`でOutcomeを取り、Project Constraintsをsnapshot | Outcome（Workspace）・Target・Project所属Workspaceの一致を検査し、ConstraintsはWorkspaceから取る。Repository参照はProjectのまま | S04-03 |
| `GetOrchestrationStateUseCase.ts`（`OrchestrationState.project`） | 1 Projectの状態 | Workspace単位の集約（Outcomes・Targets・Project別Work summary） | S08-01 |
| `GetStrategistContextUseCase.ts`・`GetResearcherContextUseCase.ts`・`GetEvaluatorContextUseCase.ts` | `project`全体と`projectId`で集約 | Workspace Context（Mission等・Project要約・Target） | S03-02、S04-02、S05-02、S07-03 |
| `outcomeCorrelation.ts`（`outcome:{outcomeId}`） | Project非依存 | 変更なし | — |
| `packages/work/src/application/TaskCoordinationService.ts`・`ExecutionOperatorUseCases.ts`・`ExecutionReadUseCases.ts` | Project scope、`ProjectGrantReader`・`ProjectStateReader` | 変更なし。`issue_story`のOutcome参照検査だけS04-03で変わる | S04-03 |
| `packages/access/src/domain/ProjectRole.ts`、`application/ProjectAuthorizationService.ts`・`GrantProjectRoleUseCase.ts`・`RevokeProjectRoleUseCase.ts`・`ListProjectGrantsUseCase.ts`・`projectGrantSchema.ts` | 7 RoleをProject scopeに集約 | Workspace Role（strategist / researcher / evaluator）とProject Role（manager / worker / reviewer）に分け、Role-scopeの組合せを検証 | S06-02 |
| `application/RuntimeAuthorizationService.ts`、`AccessCredentialUseCases.ts`・`credentialSchema.ts`、`domain/AccessCredential.ts` | `requireScope(caller, projectId, scope)`、Credentialは`projectId` | scope kind / scope IDで検証 | S06-03 |
| `application/HumanProjectAuthorizationService.ts`・`HumanProjectUseCases.ts`・`ProjectMembershipUseCases.ts` | HumanのDirection操作もProject Membershipで認可 | Direction・Workspace管理はWorkspaceMembership、WorkはProjectMembership | S06-01、S06-04 |
| `infrastructure/SQLiteHumanAccountRepository.ts`（`adoptOrphanProjects`） | owner不在Projectをplatform ownerへ | Workspaceにも同じ扱いが必要かをS06-01で判断 | S06-01 |
| `packages/activity/src/domain/Activity.ts`・`application/ActivityUseCases.ts`・`activitySchema.ts`・`port/ActivityProjectReader.ts`・`infrastructure/KyselyActivityStore.ts` | system / project scope | workspace scopeと`workspaceId`を追加 | S07-01 |
| `application/canonicalWorkActivity.ts`（`WorkChangeFact`・`recordCanonicalWorkActivity`） | Workの状態変更を`projectId`だけでproject scopeへappend | `WorkChangeFact`に所属Workspace IDを加え、project scopeのまま`workspaceId`を渡す | S07-01 |
| `application/canonicalDirectionActivity.ts`（`DirectionChangeFact`・`recordCanonicalDirectionActivity`） | DirectionのActivityを`projectId`でproject scopeへappend | `DirectionChangeFact`を`workspaceId`にしworkspace scopeでappend。`project_archived`はorganization由来のproject scopeの記録として外す | S02-03（`project_archived`）、S07-01 |
| `application/ActivityUseCases.ts`の`RecordActivityUseCase`、`port/ActivityProjectReader.ts`の`ActivityProjectState` | `record_activity`を`projectId`だけでproject scopeへappend | `ActivityProjectState`に所属Workspace IDを加え、appendへ渡す。workspace scopeの明示記録はS07-02 | S07-01、S07-02 |
| `server/src/infrastructure/repository/contextAdapters.ts`の`workChangeActivityObserver`・`directionChangeActivityObserver`・`activityProjectReader` | ChangeやDirectionの通知から`project_id`だけを渡す | 同じexecutorでorganizationのProject readerから所属Workspace IDを解決して渡す（Work・Change Logへ`workspace_id`を足さない）。Directionの通知は`workspaceId`を持つものはそのまま使う | S07-01、S03-01〜03 |
| `packages/direction/src/infrastructure/directionChange.ts`（`DirectionChangeNotice`）と通知元 | `projectId`必須 | 「Directionの状態変更通知」の表のとおり`workspaceId`へ。`project_archived`はorganizationへ | S02-03、S03-01〜03 |
| `server/src/application/agentContext/GetRoleContextUseCase.ts`・`AgentContextService.ts` | `get_role_context({ projectId, role })`、Project全体とProject Activity | Workspace Role向けとProject Role向けのContextを分ける | S07-03、S07-04 |
| `server/src/infrastructure/repository/contextAdapters.ts`、`bootstrap/createApplicationServices.ts`・`database/*` | Context間のreader配線とschema合成 | organizationのschema・readerを合成に加える | S02-01〜03 |

## 公開入口

### MCP（`server/src/mcp/`）

| tool | 現在の入力 | 変更 | Task |
| --- | --- | --- | --- |
| `create_project` / `update_project` / `list_projects` / `get_project` | Projectと戦略値 | Project（purpose・Resource）とWorkspaceの参照へ。Workspace作成・Mission等の管理はHuman Web UIの操作で、MCPへ無条件に公開しない | S02-04、S03-04 |
| `create_intent` / `list_intents` / `get_intent` / `update_intent` / `abandon_intent`、`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`、`create_direction_decision` / `decide_next_outcome`、`get_research_request` / `list_research_requests` / `register_research_result` / `register_research_synthesis` / `complete_research_request`、`get_strategist_context` / `get_researcher_context` / `get_evaluator_context` / `record_outcome_evaluation` | `projectId` | `workspaceId`へ。`projectId`をWorkspace IDと解釈する互換を作らない | S03-04、S05-02 |
| `create_adr_handoff_request` / `record_adr_reference` / `list_adr_references` | `projectId`・`repositoryId` | `workspaceId`とProject固有の`projectId` | S03-04 |
| `fetch_runtime_events` / `ack_runtime_event` / `record_execution_evidence` / `get_outcome_execution_summary` | `projectId`、Runtime scope | Workspace（EvidenceとSummaryはTarget Projectも） | S03-04、S05-01 |
| `get_orchestration_state` | `projectId` | Workspace単位 | S08-01 |
| （新規）Outcome Targetの設定・解除・一覧 | — | Strategistが使う | S04-01 |
| `get_role_context` | `projectId`・`role` | Workspace Role向けとProject Role向けを分ける | S07-03、S07-04 |
| `get_role_instructions` / `list_skills` / `get_skill_context` | Project非依存 | 変更なし | — |
| Work tools（`list_stories`〜`reject_task`、`registerExecutionTools.ts`） | `projectId` | 変更なし。`issue_story`のOutcome参照検査だけS04-03 | S04-03 |
| `record_activity` / `list_activities` / `get_activity` | `projectId` | workspace scopeの記録・取得を追加 | S07-01、S07-02 |

`X-Compass-Active-Role`の解決（`server/src/auth/resolvePrincipal.ts`）は`projectRoles`だけを受け付ける。Workspace Roleを加えるときにscopeとの組合せ検証をS06-02・S06-04で行う。

### Web API（`server/src/bootstrap/app.ts`）

| route | 変更 | Task |
| --- | --- | --- |
| `/api/projects`・`/api/projects/:projectId`（GET / POST / PATCH）・`/archive` | Projectの参照とWorkspaceへの所属。Workspaceの作成・参照・更新・archiveの入口を追加 | S02-04、S09-03 |
| `/api/projects/:projectId/intents…`・`/intents/:intentId/outcomes…`・`/research-requests…`・`/intents/:intentId/decisions`・`/adr-references`・`/outcomes/:outcomeId/evaluations`・`/outcomes/:outcomeId/execution-summary`・`/outcomes/:outcomeId/execution-evidence`・`/runtime-events…` | Workspace配下の経路へ。Project配下の旧経路をWorkspaceの別名として残さない | S03-04、S05-01 |
| `/api/projects/:projectId/grants`・`/credentials` | Workspace用のGrant・Credentialの入口を追加。ProjectのものはProject Roleに限る | S06-02、S06-03、S11-03 |
| `/api/projects/:projectId/members`・`/invitations` | 維持。WorkspaceMembershipの入口を追加 | S06-01、S11-03 |
| `/api/projects/:projectId/execution`・`/changes`・`/stories`・`/tasks…` | 変更なし | — |
| `/api/projects/:projectId/activities…` | 維持し、Workspace Activityの入口を追加 | S07-02 |
| `/api/auth/*`・`/auth/*`・`/health` | 変更なし | — |

### Web UI（`server/src/web/`）

| 対象 | 変更 | Task |
| --- | --- | --- |
| `main.tsx`のroute（`/projects/:projectId/...`）、`paths.ts` | Workspace選択と`Overview / Direction / Projects / Activity / Agents`の導線。Intent・Outcome・Researchの経路をWorkspace配下へ | S09-02、S10-01〜02 |
| `features/project/`（`ProjectListPage`・`ProjectDetailPage`・`ProjectOverview`・`ProjectForm*`・`overview.ts`）、`projectForm.ts`・`projectArchive.ts` | Mission等の表示・編集をWorkspaceへ。ProjectはPurpose・Resource・Work | S09-03、S10-03 |
| `features/intent/`・`outcome/`・`research/`・`decision/`・`adr/`、`intentForm.ts`・`outcomeForm.ts`・`researchForm.ts`・`directionDecisionForm.ts`・`adrReferenceForm.ts` | Workspace Directionへ。OutcomeからTarget Project・Storyへの遷移 | S10-02 |
| `features/execution/`（`ExecutionSection`・`TaskDetailPage`・`ClaimHolderSection`等） | Project配下のまま。Workspace→Projectの遷移に接続 | S10-03、S10-04 |
| `features/activity/`・`grant/`・`credential/`・`member/`、`permissions.ts`・`projectAccess.ts`・`useProjectAccess.ts` | scope別の表示と、Workspace / Projectの権限の区別 | S11-01〜03 |
| `styles.css`・`components/` | SCSSのトークンと共通部品 | S09-01 |

## Orchestrator・Ralph

| 対象 | 現況 | 変更 | Task |
| --- | --- | --- | --- |
| `orchestrator/src/config.ts` | `projects[]`（`projectId`・`tokenEnv`） | Workspace単位の設定へ。既存Project設定からの移行手順を示す | S08-03 |
| `state.ts`・`compassClient.ts` | `get_orchestration_state({ projectId })` | Workspace単位の状態 | S08-01 |
| `plan.ts` | dispatch key `projectId:role:...`、`state.project.status !== "active"`で停止 | `workspace:project:role:outcome`等のkey。Targetなし→strategist、Story未作成のTarget→そのProjectのmanager、全Target還流→evaluator。archived Workspace / Projectを除外 | S08-02、S08-03 |
| `dispatchStore.ts` | 記録のkeyがProject IDで始まる（`prune`もProject前方一致） | 新keyへ。既存記録はkeyが変わるため、切替時に実行中の起動が二重にならない手順を確認する | S08-03 |
| `launcher.ts` | Agentへ`COMPASS_PROJECT_ID`と`get_role_context({ projectId })`の指示を渡す | Workspace RoleはWorkspace ID、managerはProject ID | S08-03 |
| `ralph/bin/ralph-loop`・`backends/compass.sh`・`prompts/*.md`・`examples/config.json` | `projectId`でWork toolsを呼ぶ | 変更なし（Project scopeの実行ループのまま）。Contextの取得先だけS07-04に追随 | S07-04、S08-04 |

## Role・Policy・Skill文書

`roles/strategist.md`・`researcher.md`・`evaluator.md`・`runtime.md`・`manager.md`、`policies/role-policy.md`、`skills/accept-task.md`は`projectId`とProject scopeを前提に書かれている。tool入力を変えるTask（S03-04、S04-01、S06-02、S07-03〜04、S08-01）で、同じTaskの中で該当Roleの文書を更新する。`roles/worker.md`・`reviewer.md`とRalphのpromptはProject scopeのまま。

## 互換期間とrollback

| 段階 | 互換期間の扱い | rollbackの確認点 |
| --- | --- | --- |
| S02-02（Workspace追加・`workspace_id`補完） | 既存列を維持し、読取は従来どおりProjectでも動く | 追加table・nullable列だけなので、旧serverで同じDBを起動しても動作することを確認する。適用前にDB fileを複製し、複製から戻せることを手順に残す |
| S02-03・S03-01〜03（読取→書込の切替） | Direction tableの`project_id`は値を残したまま`workspace_id`を正とする | 切替後に作られた行は旧serverから見えない・矛盾するため、戻す場合はDB fileの複製へ戻す。切替前後で既存ID・件数が一致することをテストする |
| S03-04・S06・S08（公開契約の切替） | Agent・Orchestrator・Ralphの設定と同時に切り替える。`projectId`をWorkspace IDとして受け付ける別名を作らない | 旧入力が明示的なエラーになることをテストし、黙って別scopeで動かない |
| S05-01・S06-03・S07-01（table再作成） | 再作成は1 tableずつ別のTaskで行う。S07-01はActivityの全書込経路が正しいscopeとIDを渡す変更（Directionのworkspace scopeへの切替を含む）と同時に行い、S03-01の通知切替より前に完了させる | 再作成前後で行数・主キー・cursor・FK違反0件を比較するテストを置く。S07-01は複数Project所属WorkspaceでWork・Direction・Project archiveの状態変更が移行後schemaでrollbackせず、scope・IDの組合せが正しいことを確認する |
| S12-01（旧列・旧Grantの削除） | 利用実態の確認後に行う | 一度にすべて削除しない。削除はDB fileの複製を取ってから行う |

## 回帰の根拠になる既存テスト

| 領域 | test file | 主に影響するTask |
| --- | --- | --- |
| Project・archive | `server/tests/projectAdapters.test.ts`・`projectArchive.test.ts`・`projectArchiveUi.test.ts`・`projectForm.test.ts`・`projectOverviewUi.test.ts`・`emptyStateUi.test.ts`、`packages/direction/tests/project.test.ts`・`updateProject.test.ts` | S02 |
| Direction | `intent*.test.ts`・`outcome*.test.ts`・`research*.test.ts`・`initialResearch.test.ts`・`additionalResearch.test.ts`・`directionDecision.test.ts`・`adrHandoff.test.ts`・`strategist*.test.ts`・`researcherMcp.test.ts` | S03 |
| Execution還流・評価 | `executionEvidence.test.ts`・`executionHandoff.test.ts`・`executionPlan.test.ts`・`outcomeEvaluation.test.ts`・`evaluationReplan.test.ts`・`outcomeConfirmed.test.ts`・`runtimeEvents.test.ts`・`lv6ClosedLoop.test.ts` | S04、S05 |
| Work | `packages/work/tests/taskCoordination.test.ts`、`server/tests/execution*.test.ts`（Mcp・Coordination・Operator・WebRead・Ui・Boundary） | S04-03、S12-02 |
| Access | `projectGrant*.test.ts`・`grantForm.test.ts`・`activeRole.test.ts`・`accessCredential.test.ts`・`credentialUi.test.ts`・`human*.test.ts`・`membershipUi.test.ts`・`remoteMcpHumanCommands.test.ts` | S06 |
| Activity・Role Context | `packages/activity/tests/activityStore.test.ts`、`server/tests/activity.test.ts`（Work・Directionの状態変更と同じtransactionのcanonical Activity、`record_activity`）・`activityUi.test.ts`・`agentContext.test.ts`・`instruction.test.ts` | S07 |
| Orchestrator・Ralph | `server/tests/orchestrationState.test.ts`、`orchestrator/tests/*.test.ts`、`ralph/tests/ralph.test.ts` | S08 |
| 入口全体 | `server/tests/app.test.ts`・`frontendApi.test.ts`・`executionBoundary.test.ts`（package間のDB直接操作の検査） | 全Story |

新規に必要なテスト（ADRとhandoffの必須テスト）は各Taskの受入条件に従う。既存DBからの移行は、旧schemaで作ったDB fileに対してserverを起動し、ID・件数・cursorの保持と再起動時の冪等性を確認する形で、S02-02・S03・S06-03・S07-01・S12-02に置く。
