# Workspace移行 影響マップ

[ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md)を現行コードへ適用するときの、ファイル単位の変更先・schema・公開入口・検証条件。[移行計画](architecture-migration-plan.md)のWorkspace Story 02〜12の各Taskは、着手時に本書の該当行を前提として確認する。記載は変更先の定義であり、実装の完了を意味しない。

Compassはリリース前のため、開発DBはtableのDROPまたはDB file削除で再作成してよい。旧DBのデータ変換・IDやCredentialの引継ぎ・旧server互換を必須にしない。開発用WachaのDBは再作成対象に含めない。旧列・旧table・互換migrationコードは関連Taskで削除できる。新規DBの正しいscope・FK・index・保存と、同じschemaでの再起動を検証する。実行中のDBを削除する場合は、先にDBを開いているCompassプロセスを停止する。

現況は各Taskで反映済みのコードとテストに合わせる。実装状況は[実装状況](implementation-status.md)、受入状態はWachaで確認する。Task番号は「S03-01」（Workspace Story 03のTask 01）の形で示す。

## 前提となる現況

- DBは単一SQLite file（`COMPASS_DB_PATH`、`server/src/bootstrap/database/createDatabase.ts`）で、`foreign_keys = ON`。table定義は各packageの`infrastructure/schema.ts`、初期化は`initialize*Schema.ts`をserverの`initializeSchema.ts`が順に呼ぶ（Organization → Direction → Work → Access → Activity）。
- migrationのversion管理はない。`create ... if not exists`と、`pragma_table_info`で列の有無を見る冪等な`ALTER TABLE ADD COLUMN`（Organizationのarchive・`workspace_id`・`strategy_migrated_at`、Directionの評価参照、Workの`active_role`）で既存DBへ追随する。server起動のたびに実行される。
- OrganizationはWorkspaceとProjectを保存する。DirectionのIntent・Outcome・成功条件はWorkspace所有で、`intent.workspace_id`・`outcome.workspace_id`は`workspace.id`をFK参照し、成功条件は`outcome_id`でOutcomeを参照する。Research/Decision/ADRはWorkspace scopeへ切替済みで、ADRは対象artifactのProject/Repository参照も持つ。Evaluation・Runtime event・配送・ackはWorkspace scope。Execution Summary/EvidenceはWorkspace所有で発生元Projectも保持し、Outcome/ProjectのWorkspace一致は複合FKで強制する。WorkはProject scopeで、`project_id`は`project.id`を参照する。Activityは`workspace_id`で`workspace.id`、`project_id`で`project.id`を参照し、3 scopeとID組合せのCHECKを持つ。Direction canonical ActivityはWorkspace scopeで内部保存・取得まで実装済み。Directionの通知はEvaluationを含め全てWorkspace IDを直接使う。AccessにはProject単位のtableに加え、`workspace_membership`があり`workspace.id`を参照する。Workspace DirectionのWeb/API/MCP入口はWorkspace Membership・Role Grant・Runtime Credentialで認可する（S03-04で接続済み）。Workspace Role Grantの付与・取消、Workspace member管理は未接続。Workspace ActivityのMCP・Web API（S07-02）とWorkspace Role Context（S07-03）は接続済みで、Web UIは未接続。
- Projectの戦略値（Mission等）を読むのは`DirectionReferenceLookupService`（Story作成時のConstraints snapshot）、`GetRoleContextUseCase`、`GetStrategistContextUseCase`（`workspace`を返す）、Web UIの`ProjectDetailPage`・`ProjectListPage`・`projectForm.ts`。
- `server/tests`・各packageのテストにはProject作成入力の`mission`を使うfixtureがある。Project作成の入力契約を変えるTaskは`projectWorkspaceMigration.test.ts`・`projectAdapters.test.ts`等と関連fixtureの追随を含む。

## SQLiteの制約から決まる作業

| 変更 | SQLiteで可能な方法 | 対象 | 該当Task |
| --- | --- | --- | --- |
| 列の追加 | 新規DBのCREATE定義へ直接追加する | `project.workspace_id`、Direction各tableの`workspace_id` | S02-02、S03-01〜03 |
| `NOT NULL`化・CHECK制約の変更・主キーの変更 | CREATE定義を更新し、開発DBをDROPまたはfile削除で再作成する | `activity`（scopeのCHECK）、`outcome_execution_summary`（PK）、`access_credential`（scope） | S05-01、S06-03、S07-01 |
| FK付き列・index付き列の削除 | 参照元を切り替え、CREATE定義から旧列・indexを除いてDBを再作成する | Direction各tableの旧`project_id` | S03、S12-01 |

schema再作成の共通確認点:

- 空DBから全table・FK・index・partial unique indexが作られることと、`pragma foreign_key_check`で違反0件を確認する。
- `activity.cursor`・`runtime_event.sequence`・`change_log.cursor`は新しいDB内で単調に増え、保存済みデータは同じschemaでの再起動後も参照できることをテストする。
- server再起動で`initialize*Schema`を再実行しても同じ状態になる（冪等）ことを確認する。

## DB table

各Taskで必要なschema・読取・書込を切り替える。旧データ変換のために列やtableを残す段階は必須にしない。

### Organization（`packages/organization`が所有）

| table | 現況 | 変更先 | Task | 構造・制約の確認点 |
| --- | --- | --- | --- | --- |
| `workspace` | 作成・参照・更新・archiveを保存済み | id・name・mission・vision・status・archived_at・archive_reason・created_at・updated_at | S02-01 | Workspaceのarchiveは新規活動を拒否する。`project`のarchive列と同じ規則 |
| `workspace_principle` / `workspace_constraint` | Workspaceの子として保存済み | `project_principle` / `project_constraint`と同じ`OrderedTextTable`形 | S02-01 | — |
| `project` | `workspace_id`・`strategy_migrated_at`を追加済み。`mission`・`vision`は読み書きしない旧列。FKの参照先 | `workspace_id NOT NULL`（FK `workspace.id`）とProject固有値。不要なmission・vision・移行用列を除く | S02、S12-01 | 新規DBから全ProjectがWorkspaceに属することをDBとapplicationで保証する |
| `project_principle` / `project_constraint` | 読み書きしない旧table | 旧tableを除き、Workspaceの子を使う | S12-01 | 新規Workspaceの値と並び順（`sort_order`）を検証する |
| `project_repository_link` / `project_resource` | Projectの子（`packages/organization`が所有） | 変更なし | S02-03（実装済み） | 新規DB内で`adr_handoff_request.repository_id`・Activityの`project_resource`参照・Storyの`repository_snapshot`が同じResourceを指すことを確認する |

現行のOrganizationには`migrateProjectStrategy.ts`による旧戦略値の変換と、ProjectからWorkspaceの戦略値を編集する互換経路がある。新しい所属・入力契約を接続したTaskで不要な変換・互換コードを除いてよい。ProjectからWorkspaceの戦略値を編集する互換経路はS09-03で除いた。旧ProjectごとのWorkspace生成は今後の受入条件ではない。現行の`POST /api/projects`・MCP `create_project`は専用Workspaceを同じtransactionで作る。この公開契約の切替は後続Taskで行う。Projectのarchiveは所属Workspaceをarchiveしない（S09-03でWorkspace ownerのarchiveと分離した）。Workspaceへの所属を選ぶ入口はS02-04・S09-03で接続する。

### Direction（Workspace scopeへ。S03）

| table | 現況のscope・制約 | 変更先 | Task | 確認点 |
| --- | --- | --- | --- | --- |
| `intent` | `workspace_id` FK。`intent_one_active_per_workspace`（Workspaceにつき有効1件） | 実装済み | S03-01 | 同じWorkspaceに複数ProjectがあってもActive IntentはWorkspaceにつき最大1件 |
| `outcome` | `workspace_id` FKと`(intent_id, workspace_id)`の複合FK | 実装済み | S03-01 | `success_criterion`は`outcome_id`だけで変更なし |
| `research_request` / `research_result` / `research_evidence_ref` / `research_finding` / `research_synthesis` | `workspace_id` FK・親子複合FK、Requestの`(workspace_id, request_key)` unique、`research_finding_workspace_idx`等 | 実装済み | S03-02 | 関連tableはscope列なし。EvidenceはURI/revisionと任意の`resource_id`で同じWorkspaceのProject Resourceを参照 |
| `direction_decision` | `workspace_id` FK、`(workspace_id, request_key)` unique・Intent/Outcome複合FK | 実装済み | S03-02 | `direction_decision_synthesis` / `_finding`は変更不要。Intent Brief snapshot（JSON）は書き換えない |
| `adr_handoff_request` / `adr_reference` | `workspace_id`と対象artifactの`project_id`・`repository_id`。DecisionとのWorkspace複合FK | 実装済み | S03-02 | `(workspace_id, request_key)` unique。対象Projectが同じWorkspaceに属することをtransaction内で検査 |
| `runtime_event` / `runtime_event_delivery` / `runtime_event_ack_attempt` | `workspace_id` FK、`runtime_event_workspace_sequence_idx`、version 2 | `workspace_id` | S03-03 | 新規DBでsequence・配送・ack・再送を検証する。`fetch_runtime_events` / `ack_runtime_event`はS03-04でWorkspace Runtime Credentialの入口へ接続済み（Orchestratorは`get_orchestration_state`を使い、これらに依存しない） |
| `outcome_execution_summary` | PK `(outcome_id, project_id)`、`workspace_id`・`project_id` | 保存構造を維持し、Target Projectだけが還流する（S05-01で実装済み） | S03-03（保存）、S05-01（Target別還流） | 新規DBで同じOutcomeのProject別Summaryを区別する |
| `outcome_execution_evidence` | `workspace_id`・`project_id`、identity index `(outcome_id, project_id, kind, uri, version)` | 発生元Projectを保持し、還流時にTargetを検査する。上限はOutcome・Projectごと（S05-01で実装済み） | S03-03、S05-01 | 複数Projectが同じURIを報告してもProject別に保持する |
| `outcome_evaluation` | `workspace_id` FK、`(workspace_id, request_key)` unique | `workspace_id`。評価snapshot（JSON）は全Targetの`projectId`・`projectStatus`・Summary / EvidenceをProject別に含む（S05-02で実装済み） | S03-03、S05-02 | 既存snapshotは書き換えない |
| `outcome_target_project` | `outcome_id`・`project_id`・`created_at`、主キー`(outcome_id, project_id)`、`outcome.id`・`project.id`へのFK | 実装済み | S04-01 | 旧OutcomeのTarget補完は不要。新規OutcomeはTargetなしを許容し、Strategistが設定する。Workspace一致はRepositoryが書込と同じtransactionで検査する |

S03-01〜03で新規DBのDirection tableと読取・書込を`workspace_id`へ切り替える。Project固有参照に必要な`project_id`以外は、参照元を切り替えたTaskで旧列・indexを除いてよい。`project_id`列にWorkspace IDを保存しない。

S03-01はIntent/Outcomeのdomain・Repository・10 use case・保存列・通知をWorkspaceへ切替済み。S03-04でDirectionの公開Web API（`/api/workspaces/:workspaceId/…`）・MCP（`workspaceId`入力）・Strategist / Researcher / Evaluator ContextをWorkspace Membership・Workspace Role Grant・Workspace Runtime Credentialへ接続し、Project配下の旧経路・`projectId`入力・Project ContextのDirection adapterを除いた。Project基準のまま残るOrchestration Stateだけが`projectDirectionAdapter.ts`/`ProjectDirectionReaders`で所属Workspaceを明示解決し、複数ProjectのWorkspaceを拒否する（S08-01で切替）。Story作成時のOutcome参照はS04-03で`DirectionReferenceLookupService`のWorkspace Outcome snapshot＋Project execution contextへ切替済み。Research/Decision/ADRの保存・検索はWorkspace IDを直接使う。Evaluation/Runtimeの保存・取得もWorkspaceを直接指定する。Execution Summary/Evidenceは所属WorkspaceとProjectを明示し、両者とOutcomeの一致をtransaction内のreaderと複合FKで強制する。Runtimeの`outcome_confirmed`・`research_requested`・`research_completed`はserverの`directionChangeObserver`がProject数によらずWorkspace eventへ投影する。Workspace Runtime eventの認可付き公開入口はS03-04で接続済み。OrchestratorはS08-03でWorkspace単位の状態（`get_workspace_orchestration_state`）へ切り替えた（Runtime eventには依存しない）。

### Work（Project scopeを維持）

| table | 現況 | 変更 | Task |
| --- | --- | --- | --- |
| `story` | `project_id` FK、`outcome_ref`（FKなし）、`correlation_id`、`story_project_correlation_idx`（`(project_id, correlation_id)` unique） | 変更なし。相関ID`outcome:{outcomeId}`の一意性がProject単位なので、1つのOutcomeからTarget Projectごとに別Storyを作れる。作成時のTarget検査は実装済み | S04-03（作成時の検査のみ） |
| `task` / `task_comment` / `task_claim` / `change_log` / `command_receipt` | `project_id`（task・change_log）、Claim・状態遷移 | 変更なし | — |

WorkのProject scope、Claim・状態遷移・Change Logの規則を維持し、S12-02で新規DBのfixtureから検証する。

### Access

| table | 現況 | 変更先 | Task | 構造・制約の確認点 |
| --- | --- | --- | --- | --- |
| `project_grant` | PK `(project_id, principal_id, role)`。roleはCHECKなしでstrategist〜runtimeの7種 | Projectの`manager` / `worker` / `reviewer`とWorkspaceの`strategist` / `researcher` / `evaluator`を分ける | S06-02 | 新規発行でRole/scopeの不一致を拒否する。旧Grantのコピーは不要。`runtime`のGrant（trusted-local）のscopeはS08-03で決める |
| `workspace_role_grant`（新規） | — | `(workspace_id, principal_id, role)` | S06-02 | GrantからProject権限を継承しない |
| `project_membership` / `project_invitation` | Project単位、最後のowner保護 | 変更なし | — | — |
| `workspace_membership` | S06-01で追加済み。有効な行は(Workspace, Human)につき1件 | Workspaceの閲覧・Direction管理・Project作成・member管理 | S06-01（実装済み） | Workspace作成時のownerとProject権限の非継承を検証する。旧Membershipの補完は不要。owner不在時の運用規則は維持する |
| `access_credential` | `project_id NOT NULL` FK、`kind`（agent / runtime）、`scopes_json`、`secret_hash` | scope kind（workspace / project）とscope IDを持つCREATE定義へ | S06-03 | 新規発行するCredentialのscope・期限・失効・秘密値非公開を検証する。旧Credentialの引継ぎは不要 |
| `human_user` / `human_identity` / `web_session` / `auth_login_attempt` | Project非依存 | 変更なし | — | — |

### Activity

| table | 現況 | 変更先 | Task | 確認点 |
| --- | --- | --- | --- | --- |
| `activity` | `scope in ('project', 'workspace', 'system')`のCHECK、`activity_scope_ids_check`、`workspace_id` / `project_id` FK、cursor・indexを実装済み | 保存schemaの追加変更は不要。Workspaceの公開記録・取得は接続済み | S07-01・S07-02（実装済み） | systemは両IDなし、workspaceは`workspace_id`のみ、projectは両ID必須。新規DBでscope/ID・cursor・dedupe・訂正参照と状態変更の原子性を検証する。旧Activityの補完は不要 |

Activityを書く経路は次の4つ。scope/IDの保存は実装済み。Intent/Outcome/Research/DecisionのDirection通知は所有するWorkspace IDを直接渡す。Project IDを持つ未移行のDirection通知とWork・Project archive・明示記録は、serverが同じtransactionのexecutorでOrganizationのProject readerを配線して所属Workspaceを解決し、所属欠損は補正せず拒否する。canonical Activityは状態変更と同じtransactionで追記するため、所属解決が必要な経路での解決失敗やActivity追記の失敗は状態変更も巻き戻す。WorkではChange Logも巻き戻す（Story / Taskの起票・完了・レビュー・受入・差戻し・取消）。Direction操作・Project archiveも状態変更とActivity追記を同じtransactionで行う。明示記録も所属解決・参照検証・appendを同じtransactionで行う。

append-only・訂正追記・cursor・dedupe・操作者の`principalId` / `role`の意味は維持する。所属Workspaceの追加をRole Grantの継承やworkflow checkpointには使わない。

| 経路 | 現行の書込 | 同じtransactionの内容 | 現行のscope / ID |
| --- | --- | --- | --- |
| Work由来のcanonical Activity | `server/src/infrastructure/repository/contextAdapters.ts`の`workChangeActivityObserver`がChangeの`project_id`から所属Workspaceを解決し、両IDを`WorkChangeFact`へ渡す。`packages/activity/src/application/canonicalWorkActivity.ts`の`recordCanonicalWorkActivity`がappendする | `packages/work/src/infrastructure/KyselyWorkStore.ts`の業務状態変更・Change Log追記・所属解決・Activity追記（Change Log追記直後に`changeObserver`を呼ぶ） | project（`workspaceId`・`projectId`） |
| Direction由来のcanonical Activity | `contextAdapters.ts`の`directionChangeActivityObserver`が、Intent/Outcome/Research/Decision通知の`DirectionChangeNotice.workspaceId`を直接使い、未移行のEvaluation通知の`projectId`だけ所属Workspaceへ解決する。いずれも`DirectionChangeFact.workspaceId`として`canonicalDirectionActivity.ts`の`recordCanonicalDirectionActivity`へ渡す | Directionの状態変更・未移行通知の所属解決・Activity追記 | workspace（`workspaceId`のみ、`projectId=null`）。Entityの保存scopeがProjectでもcanonical ActivityはWorkspace scope |
| Project archive由来のcanonical Activity | `contextAdapters.ts`の`projectChangeActivityObserver`が`ProjectChangeNotice.projectId`から所属Workspaceを解決し、両IDを`canonicalProjectActivity.ts`の`ProjectChangeFact`へ渡す。通知自身も`workspaceId`を持つが、observerは同じexecutorで所属を読み直す | `SQLiteProjectRepository.archive`の状態変更・所属解決・Activity追記 | project（`workspaceId`・`projectId`） |
| 明示記録（`record_activity`・`record_workspace_activity`） | `packages/activity/src/application/ActivityUseCases.ts`の`RecordActivityUseCase`（scopeをinstanceごとに固定）が`ActivityScopeReader`（`contextAdapters.ts`の`activityScopeReader`）からProject（所属`workspaceId`を含む）またはWorkspaceの状態と参照可能なResourceを読み、scopeに応じたIDでappendする | `ActivityUnitOfWork`内の再送照合・所属解決・Project / Workspace状態 / Resource / 訂正参照の検証・Activity追記。serverの`createApplicationServices.ts`が同じtransactionのreaderとstoreを配線する | project（`workspaceId`・`projectId`）、workspace（`workspaceId`のみ。S07-02で実装済み） |

#### Directionの状態変更通知（`DirectionChangeNotice`）

`packages/direction/src/infrastructure/directionChange.ts`の`DirectionChangeNotice`は`workspaceId`だけを持ち、次の通知元が書込と同じtransactionで送る。Directionの通知はProjectを経由せず、所有scopeのIDを直接渡す。

| 通知の種類 | 通知元（`packages/direction/src/infrastructure/`） | 現行IDの出所 | 変更後の契約 | 切替Task |
| --- | --- | --- | --- | --- |
| `intent_created` / `intent_abandoned` | `SQLiteIntentRepository.ts` | 引数の`workspaceId` | 実装済み | S03-01 |
| `outcome_confirmed` / `outcome_cancelled` | `outcomeRecord.ts`の`insertOutcomeRow`（`SQLiteOutcomeRepository.ts`・`SQLiteDirectionDecisionRepository.ts`から）、`SQLiteOutcomeRepository.ts`（取消） | 引数の`workspaceId` | 実装済み | S03-01 |
| `research_requested` / `research_closed` | `researchRequestRecord.ts`の`insertResearchRequest`（`SQLiteResearchRepository.ts`・`SQLiteDirectionDecisionRepository.ts`から）、`SQLiteResearchRepository.ts` | 引数の`workspaceId` | 実装済み | S03-02 |
| `decision_recorded` | `SQLiteDirectionDecisionRepository.ts`の`notifyRecorded` | `decision.workspaceId` | 実装済み | S03-02 |
| `outcome_evaluated` | `SQLiteOutcomeEvaluationRepository.ts` | 引数の`workspaceId` | `workspaceId` | S03-03 |
| `project_archived` | （S02-03でDirectionの通知から外した） | — | Organizationの`SQLiteProjectRepository.archive`が`ProjectChangeNotice`（`projectId`と所属`workspaceId`）を送る。Activityへの両IDの受け渡しも実装済みで、S03では変更しない | S02-03、S07-01（実装済み） |

Activity側の受け口は`canonicalDirectionActivity.ts`の`DirectionChangeFact.workspaceId`で、Project IDを受け取る契約ではない。Evaluationを含むDirectionの通知はserverのobserverへWorkspace IDを直接渡す。Activityは`DirectionChangeNotice`に依存しない。Factとworkspace scopeの保存契約は維持する。

#### 通知と保存のID契約

- Directionは`workspaceId`だけで通知し、observerもそのIDを直接使う。DirectionがOrganizationのtableからProjectを選んでscopeを解決する形にはしない。
- Execution Summary/EvidenceとADR artifactは対象Projectを明示する。新規DBでは全Projectに所属`workspace_id`を設定し、Workspace/Project/Direction参照の一致を検証する。
- `project_archived`はOrganizationの通知で、所属Workspace ID付きproject scopeのActivityとして保存する（`dedupe_key`は`direction_change:project_archived:{projectId}`）。serverの`projectChangeActivityObserver`が所属Workspaceを解決し、Activityの`recordCanonicalProjectActivity`へ両IDを渡す。


登録済みTaskの着手条件は次のとおり。Wachaは依存を自動制御しないため、着手時に受入状態を確認する。

| Task | 着手条件・切替範囲 |
| --- | --- |
| S01-02（本影響マップ） | S01-01のADR受入。Story 02受入前に移行契約を確定する |
| S07-01（`7a4bd467-99b6-48cb-ab38-a62529be43ff`） | Story 02受入。Activityのworkspace scope・全4経路のID組合せ・Direction canonical Activity切替を同時に完了し、S03-01より先に受け入れる |
| S03-01（`b5ae68d4-60a2-41c3-83ec-0c0eba31f2c0`）〜03 | Story 02の所属関連付けとS07-01受入後、Direction保存・通知・application集約をWorkspaceへ切り替える |
| S06-02〜03 | S06-01とS03-01〜03のScope切替後、Workspace Role Grant・Credentialを用意する |
| S03-04 → S06-04 | S03-01〜03とS06-02〜03受入後に認可付きDirection公開入口を接続し、その後に入口横断認可を検証する |
| S07-02 | S07-01・S03-01〜03・S06-02〜03受入後に認可付きWorkspace Activity公開入口（MCP・Web API）を接続する（実装済み） |
| S07-03 | S07-01〜02・Story 03・06受入後にWorkspace Role Context（`get_workspace_role_context`）を接続する（実装済み）。Orchestratorの起動指示はS08-03でWorkspace Roleを`get_workspace_role_context`へ切替済み |
| S07-04 | S07-03・Story 04のTarget受入後にProject Role Context（`get_role_context`）へ所属Workspaceの要約・Targetのactive Outcomeを加える（実装済み）。Ralphは`projectId`のまま |

#### project scopeの経路

- Workは`workspace_id`を持たない（Project scopeのまま）。Change Logや`WorkChangeNotice`へ`workspace_id`を足さず、serverの`workChangeActivityObserver`が同じexecutor（同じtransaction）でorganizationのProject readerから所属Workspace IDを解決して`WorkChangeFact`に渡す。Activityはprojectのtableを直接読まない現行の境界を保つ
- `RecordActivityUseCase`は`ActivityScopeState.workspaceId`（Projectは所属Workspace、WorkspaceはそのWorkspace）を受け取り、appendに渡す。所属解決・Project状態 / Resource / 訂正参照の検証・appendは`ActivityUnitOfWork`の同じtransaction内で行う。訂正は同一scope・Workspace・ProjectのActivityへの追記に限る
- Project archiveは`projectChangeActivityObserver`が通知の`projectId`から同じtransactionで所属Workspaceを読み直し、`ProjectChangeFact`へ両IDを渡す。Work・明示記録も、所属`workspace_id`が欠けている場合は操作を失敗させる。黙ってsystem scopeやnullへ落とさない

#### 参照への影響

DirectionのActivityはWorkspaceに保存され、Project Activityの一覧（`list_activities`・`/api/projects/:projectId/activities`・Web UIの`features/activity/`・`GetRoleContextUseCase`の最近のProject Activity）には出ない。内部の`ActivityStore.listWorkspace`・`maxWorkspaceCursor`は実装済みで、Workspace scopeだけを取得し、同じWorkspaceのProject Activityは含めない。既存のcursor・filterを共用する。認可付きWorkspace記録・取得のuse caseと公開入口（MCP・Web API）はS07-02、Workspace Role ContextはS07-03で接続済みで、Web UIはS11-01で接続する。開発DBを再作成する場合、旧Activityの再分類や引継ぎは不要。

#### 回帰

- 既存: `server/tests/activity.test.ts`の「Workの重要な状態変更は同じtransactionでcanonical Activityになり、再送・Claim操作では増えない」「Directionの重要な状態変更は同じtransactionで操作者付きのcanonical Activityになり…」「Agentはsummary必須…」と、`server/tests/execution*.test.ts`のStory / Task操作を移行後schemaで実行する
- 実装済みの回帰: 2つのProject（A・B）が所属するWorkspaceで、現行schemaに対し次を確認する
  - Direction変更（Intent作成・Outcome確定・Research・Decision・Evaluation）: workspace scope、`workspace_id`が当該Workspace、`project_id`がnull。AにもBにもProject Activityが作られない
  - Project Aのarchive: project scope、`project_id`がA、`workspace_id`が当該Workspace。Bの履歴に出ない
  - Project BのWork状態変更: project scope、`project_id`がB、`workspace_id`が当該Workspace
  - それぞれでActivityの追記を失敗させると、Direction操作・archive・Work状態変更が同じtransactionで巻き戻る（原子性）
- S03で追加確認: 切替途中（`projectId`の通知と`workspaceId`の通知が混在）でも上記と同じ結果になる

## applicationとpackage

| 対象（現行ファイル） | project依存 | 変更先 | Task |
| --- | --- | --- | --- |
| `packages/organization/src/domain/Project.ts`・`ProjectRepository.ts`、`infrastructure/SQLiteProjectRepository.ts`・`projectState.ts`・`projectChange.ts`・`migrateProjectStrategy.ts`、`application/*Project*UseCase.ts`・`projectSchema.ts`・`error/ProjectArchivedError.ts` | Project本体（S02-03でDirectionから移設済み） | `Project`（Entity）は所属`workspaceId`を持ちMission等を持たない。公開契約用の参照モデル`ProjectDetail`がWorkspaceの戦略値を合成し、所属`workspaceId`を含む（S02-04で公開済み）。所属Project一覧は`ListWorkspaceProjectsUseCase`（S02-04で実装済み）。Direction・Access・Work・Activityが使うProject状態の読取（`DirectionProjectReaders`・`AccessProjectReaders`・WorkStoreの`projects`・`ActivityScopeReader`）はserverがorganizationの関数で配線する | S02-01、S02-03、S02-04（実装済み） |
| `SQLiteProjectRepository`のProject・専用Workspace作成時の初期owner Membership書込（`ownerMembershipWriters`経由）、Repositoryを外す前のADR参照検査（`projectRepositoryReferenceFinder`→Directionの`findAdrReferencedRepositoryId`） | 同一transactionの原子性・監査記録の参照先保持 | organization移動後も同じtransactionで行う（serverが配線） | S02-03（実装済み） |
| `packages/direction/src/application/port/DirectionProjectReader.ts`・`infrastructure/directionProjectReaders.ts` | Intent/OutcomeのUse Caseは`DirectionWorkspaceReader`でWorkspaceの存在・状態を読む。未切替のUse CaseはProject参照モデル、Repositoryは同じtransactionの`DirectionProjectReaders`でProject状態・参照・所属Workspaceを読む | S03でWorkspaceの存在・archive検査へ置き換える | S02-03（実装済み）、S03-01〜04 |
| `packages/direction/src/domain/*`（Intent・Outcome・Research・DirectionDecision・AdrHandoff・RuntimeEvent・OutcomeExecution・OutcomeEvaluation と各Repository） | Intent/Outcomeは`workspaceId`。Research/Decisionは`workspaceId`、ADRは`workspaceId`と対象artifactの`projectId`。Evaluation/Runtimeは`workspaceId`、Execution Summary/Evidenceは`workspaceId`と`projectId` | Workspace scopeのまま公開入口を接続する。Project固有参照（ADR handoff / reference、Execution Summary / Evidence）は`projectId`を併せ持つ | S03-01〜03 |
| `packages/direction/src/application/*UseCase.ts`（大半が`projectRepository`を使う）、`*Rejection.ts` | Project存在・archive検査、`requireRole(principal, projectId, role)` | Workspace存在・archive検査、Workspace scopeの認可 | S03-01〜04 |
| `application/port/DirectionAuthorizationPort.ts` | `requireRole` / `requireScope`が`projectId` | `workspaceId`へ。実装はAccessの`WorkspaceRoleGrant`・Workspace Credential | S03-04、S06-02 |
| `application/port/ExecutionSummaryPort.ts`、Workの`ExecutionSummaryService.ts` | `getOutcomeExecutionSummary(projectId, outcomeId)` | 形は維持し、Target Projectごとに呼ぶ（還流はTarget検査付きで実装済み） | S05-01 |
| `application/DirectionReferenceLookupService.ts`、Workの`port/DirectionReferenceLookupPort.ts` | `getProjectExecutionContext(projectId)`（所属Workspace・WorkspaceのConstraints・ProjectのRepository）と`getOutcomeSnapshot(workspaceId, outcomeId)`（`targetProjectIds`付き） | 実装済み。Outcome（Workspace）・Target・Project所属Workspaceの一致を`issue_story`・`get_outcome_handoff_context`で検査する。`issue_story`はTargetをStory保存と同じtransactionでも再検査する | S04-03 |
| `GetOrchestrationStateUseCase.ts`（`OrchestrationState.project`） | 1 Projectの状態。Workspace単位の集約は`GetWorkspaceOrchestrationStateUseCase.ts`（Outcomes・Targets・Target別Work summary・還流・評価可能性）で実装済み | OrchestratorはS08-03でWorkspace単位へ切替済み。Project基準のQueryの扱いは未決定 | S08-01〜03（実装済み） |
| `GetStrategistContextUseCase.ts`・`GetResearcherContextUseCase.ts`・`GetEvaluatorContextUseCase.ts` | `project`全体と`projectId`で集約 | Workspace Context（Mission等・Project要約・Target）。StrategistのProject要約・Targetは実装済み（S04-02）。Evaluator Contextの全Target・評価可能性は実装済み（S05-02）。Role共通のWorkspace Contextは`get_workspace_role_context`（S07-03）で並べて返し、これらの集約は置き換えない | S03-02、S04-02、S05-02、S07-03（実装済み） |
| `outcomeCorrelation.ts`（`outcome:{outcomeId}`） | Project非依存 | 変更なし | — |
| `packages/work/src/application/TaskCoordinationService.ts`・`ExecutionOperatorUseCases.ts`・`ExecutionReadUseCases.ts` | Project scope、`ProjectGrantReader`・`ProjectStateReader` | 変更なし。`issue_story`のOutcome参照検査だけS04-03で変わる | S04-03 |
| `packages/access/src/domain/ProjectRole.ts`、`application/ProjectAuthorizationService.ts`・`GrantProjectRoleUseCase.ts`・`RevokeProjectRoleUseCase.ts`・`ListProjectGrantsUseCase.ts`・`projectGrantSchema.ts` | 7 RoleをProject scopeに集約 | Workspace Role（strategist / researcher / evaluator）とProject Role（manager / worker / reviewer）に分け、Role-scopeの組合せを検証 | S06-02 |
| `application/RuntimeAuthorizationService.ts`、`AccessCredentialUseCases.ts`・`credentialSchema.ts`、`domain/AccessCredential.ts` | `requireScope(caller, projectId, scope)`、Credentialは`projectId` | scope kind / scope IDで検証 | S06-03 |
| `application/HumanProjectAuthorizationService.ts`・`HumanProjectUseCases.ts`・`ProjectMembershipUseCases.ts` | HumanのDirection操作もProject Membershipで認可 | Direction・Workspace管理はWorkspaceMembership（`HumanWorkspaceAuthorizationService`・`HumanWorkspaceUseCases.ts`・`WorkspaceMembershipUseCases.ts`をS06-01で追加済み）、WorkはProjectMembership。Directionの入口の切替はS03-04・S06-04 | S06-01（実装済み）、S06-04 |
| `infrastructure/SQLiteHumanAccountRepository.ts`（`adoptOrphanProjects`） | owner不在Projectをplatform ownerへ | owner不在のWorkspaceも同じ規則でplatform ownerへ補完する（`adoptOrphanWorkspaces`） | S06-01（実装済み） |
| `packages/activity/src/domain/Activity.ts`・`application/ActivityUseCases.ts`・`activitySchema.ts`・`port/ActivityScopeReader.ts`・`infrastructure/KyselyActivityStore.ts` | system / workspace / project scopeと`workspaceId`。公開入口の対象は`ActivityTarget`（project / workspace） | 実装済み | S07-01・S07-02（実装済み） |
| `application/canonicalWorkActivity.ts`（`WorkChangeFact`・`recordCanonicalWorkActivity`） | Workの状態変更を所属`workspaceId`と`projectId`でproject scopeへappend | 実装済み | S07-01（実装済み） |
| `application/canonicalDirectionActivity.ts`（`DirectionChangeFact`・`recordCanonicalDirectionActivity`） | `DirectionChangeFact.workspaceId`でworkspace scopeへappend（projectIdなし） | 実装済み。通知元のID切替はS03-01〜03 | S07-01（実装済み） |
| `application/canonicalProjectActivity.ts`（`ProjectChangeFact`・`recordCanonicalProjectActivity`） | Project archiveを所属`workspaceId`と`projectId`でproject scopeへappend | 実装済み | S07-01（実装済み） |
| `application/ActivityUseCases.ts`の`RecordActivityUseCase`、`port/ActivityScopeReader.ts`の`ActivityScopeState` | 所属Workspaceの解決・検証とappendをActivityUnitOfWorkの同じtransactionで行う。workspace scopeの明示記録も同じuse caseで行う | 実装済み | S07-01・S07-02（実装済み） |
| `server/src/infrastructure/repository/contextAdapters.ts`の`workChangeActivityObserver`・`directionChangeActivityObserver`・`projectChangeActivityObserver`・`activityScopeReader`・`activityAuthorization` | 同じexecutorのOrganization readerで所属Workspaceを解決し、欠損は拒否。Direction通知のProject IDはWorkspace IDへ解決してActivityへ渡す | Direction通知元をworkspaceIdへ切り替えた経路は直接渡す。Work・Change Logにworkspace_idは足さない | S07-01（実装済み）、S03-01〜03 |
| `packages/direction/src/infrastructure/directionChange.ts`（`DirectionChangeNotice`）と通知元 | Intent/Outcomeは`workspaceId`、未切替通知は`projectId`のunion（`project_archived`はorganization） | 「Directionの状態変更通知」の表のとおり`workspaceId`へ | S03-01〜03 |
| `server/src/application/agentContext/GetRoleContextUseCase.ts`・`GetWorkspaceRoleContextUseCase.ts`・`AgentContextService.ts` | `get_role_context({ projectId, role })`、Project全体とProject Activity | Workspace Role向け（`GetWorkspaceRoleContextUseCase`：Workspace戦略値・activeなProject要約・Workspace Activity）は実装済み。Project Role向け（`GetRoleContextUseCase`）への所属Workspace要約・Targetのactive Outcome（`ListProjectTargetOutcomesUseCase`）の追加も実装済み | S07-03、S07-04（実装済み） |
| `server/src/infrastructure/repository/contextAdapters.ts`、`bootstrap/createApplicationServices.ts`・`database/*` | Context間のreader配線とschema合成 | organizationのschema・readerを合成に加える | S02-01〜03 |

## 公開入口

### MCP（`server/src/mcp/`）

| tool | 現在の入力 | 変更 | Task |
| --- | --- | --- | --- |
| `create_project` / `update_project` / `list_projects` / `get_project` | Projectと戦略値 | Project（purpose・Resource）とWorkspaceの参照へ。`list_projects` / `get_project`は所属`workspaceId`を返す（S02-04で実装済み）。Workspace自体の参照toolはWorkspace Role Grant（S06-02）まで追加しない。Workspace作成・Mission等の管理はHuman Web UIの操作で、MCPへ無条件に公開しない | S02-04、S03-04、S06-02 |
| `create_intent` / `list_intents` / `get_intent` / `update_intent` / `abandon_intent`、`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`、`create_direction_decision` / `decide_next_outcome`、`get_research_request` / `list_research_requests` / `register_research_result` / `register_research_synthesis` / `complete_research_request`、`get_strategist_context` / `get_researcher_context` / `get_evaluator_context` / `record_outcome_evaluation` | `projectId` | `workspaceId`へ。`projectId`をWorkspace IDと解釈する互換を作らない（S03-04で実装済み。Workspace Role Grant・activeRoleで認可） | S03-04、S05-02 |
| `create_adr_handoff_request` / `record_adr_reference` / `list_adr_references` | `projectId`・`repositoryId` | `workspaceId`とProject固有の`projectId`（S03-04で実装済み） | S03-04 |
| `fetch_runtime_events` / `ack_runtime_event` / `record_execution_evidence` / `get_outcome_execution_summary` | `projectId`、Runtime scope | Runtime eventは`workspaceId`とWorkspace Runtime Credential（S03-04で実装済み）。Execution Evidence / SummaryはProject固有の記録として`projectId`とProject Runtime Credentialのまま所属Workspaceを明示解決する（S03-04）。還流はTarget Projectだけが行える（`not_target_project`）。Target別の集約は`list_outcome_target_executions`（S05-01で実装済み） | S03-04、S05-01 |
| `get_orchestration_state` | `projectId` | Workspace単位の`get_workspace_orchestration_state({ workspaceId })`をWorkspace Runtime Credential（`runtime:state:read`）で追加済み。Orchestratorは切替済み（S08-03）で、Project基準のtoolは残る（扱いは未決定） | S08-01〜03（実装済み） |
| `set_outcome_target` / `unset_outcome_target` / `list_outcome_targets` | `workspaceId`・`outcomeId`・`projectId` | 設定・解除はWorkspace strategist Grant、一覧はWorkspaceの参照権限（S04-01で実装済み） | S04-01 |
| `list_outcome_target_work` | `workspaceId`・`intentId` | Intent配下のOutcomeごとのTarget別Work要約（状態・件数）。Workspaceの参照権限（S04-04で実装済み） | S04-04 |
| `list_outcome_target_executions` | `workspaceId`・`outcomeId` | OutcomeのTarget別に還流済みのExecution Summary・Evidence参照（Project別、未還流はnull、Target解除前の記録は`nonTargetExecutions`）。Workspaceの参照権限（S05-01で実装済み） | S05-01 |
| `get_role_context` / `get_workspace_role_context` | `projectId`・`role` | Workspace Role向けの`get_workspace_role_context`（`workspaceId`・Workspace Role、Workspace Role Grant）は実装済み。`get_role_context`（`projectId`・Project Role、Project Grant）はProject Role向けとして所属Workspace要約・関連Outcomeを返す（実装済み） | S07-03、S07-04（実装済み） |
| `get_role_instructions` / `list_skills` / `get_skill_context` | Project非依存 | 変更なし | — |
| Work tools（`list_stories`〜`reject_task`、`registerExecutionTools.ts`） | `projectId` | 変更なし。`issue_story`のOutcome参照検査と、Manager向けProject scopeの`get_outcome_handoff_context`追加だけS04-03 | S04-03 |
| `record_activity` / `list_activities` / `get_activity` | `projectId` | 維持。workspace scopeは`record_workspace_activity` / `list_workspace_activities` / `get_workspace_activity`（`workspaceId`、Workspace Role Grant）で実装済み | S07-01、S07-02 |

`X-Compass-Active-Role`の解決（`server/src/auth/resolvePrincipal.ts`）は`projectRoles`（Workspace Role・Project Role・`runtime`）を受け付け、scopeとの組合せはAccessが操作ごとに検査する（S06-02で実装）。公開済みのMCP・Web API・Project Role Context・Runtime向けAPIの入口横断の検証はS06-04（`server/tests/scopeAuthorization.test.ts`）。

### Web API（`server/src/bootstrap/app.ts`）

| route | 変更 | Task |
| --- | --- | --- |
| `/api/projects`・`/api/projects/:projectId`（GET / POST / PATCH）・`/archive` | Projectの参照とWorkspaceへの所属。Workspaceの作成・参照・更新・archiveの入口を追加。S02-04でProjectの応答に`workspaceId`、Workspaceの参照`GET /api/workspaces`・`/api/workspaces/:workspaceId`・`/api/workspaces/:workspaceId/projects`を追加済み。S09-03で作成`POST /api/workspaces`・更新`PATCH /api/workspaces/:workspaceId`・archive`POST /api/workspaces/:workspaceId/archive`・既存WorkspaceへのProject作成`POST /api/workspaces/:workspaceId/projects`を追加し、ProjectからWorkspaceの戦略値を編集する互換経路を除いた（実装済み） | S02-04、S09-03 |
| `/api/projects/:projectId/intents…`・`/intents/:intentId/outcomes…`・`/research-requests…`・`/intents/:intentId/decisions`・`/adr-references`・`/outcomes/:outcomeId/evaluations`・`/runtime-events…` | `/api/workspaces/:workspaceId/…`へ移した（S03-04で実装済み。Workspace Membership、Runtime eventはWorkspace Runtime Credential）。Project配下の旧経路は残さない。`/outcomes/:outcomeId/execution-summary`・`/execution-evidence`はProject固有の記録としてProject配下に残す。Target別の集約は`GET /api/workspaces/:workspaceId/outcomes/:outcomeId/target-executions`（Workspace Membership。S05-01で実装済み） | S03-04、S05-01 |
| `/api/workspaces/:workspaceId/outcomes/:outcomeId/target-projects`（GET） | Target Projectの参照（Workspace Membership）。設定・解除はStrategistのMCPだけ（S04-01で実装済み） | S04-01 |
| `/api/workspaces/:workspaceId/intents/:intentId/outcome-target-work`（GET） | OutcomeごとのTarget別Work要約（Workspace Membership。S04-04で実装済み） | S04-04 |
| `/api/projects/:projectId/grants`・`/credentials` | Workspace用のGrant・Credentialの入口を追加。ProjectのものはProject Roleに限る | S06-02、S06-03、S11-03 |
| `/api/projects/:projectId/members`・`/invitations` | 維持。WorkspaceMembershipの管理入口を追加（use caseはS06-01で実装済み。S06-04は公開済み入口の非継承だけを検証し、管理入口は追加しない） | S11-03 |
| `/api/projects/:projectId/execution`・`/changes`・`/stories`・`/tasks…` | 変更なし | — |
| `/api/projects/:projectId/activities…` | 維持。Workspace Activityは`/api/workspaces/:workspaceId/activities…`（Workspace Membership）で実装済み | S07-02 |
| `/api/auth/*`・`/auth/*`・`/health` | 変更なし | — |

### Web UI（`server/src/web/`）

| 対象 | 変更 | Task |
| --- | --- | --- |
| `main.tsx`のroute（`/projects/:projectId/...`）、`paths.ts` | Workspace選択と`Overview / Direction / Projects / Activity / Agents`の導線（S09-02で実装済み。`features/workspace/`・`/workspaces/:workspaceId/...`）。Intent・Outcome・Researchの経路をWorkspace配下へ | S09-02、S10-01〜02 |
| `features/project/`（`ProjectListPage`・`ProjectDetailPage`・`ProjectOverview`・`ProjectForm*`・`overview.ts`）、`projectForm.ts`・`projectArchive.ts` | Mission等の表示・編集をWorkspaceへ。ProjectはPurpose・Resource・Work | S09-03、S10-03 |
| `features/intent/`・`outcome/`・`research/`・`decision/`・`adr/`、`intentForm.ts`・`outcomeForm.ts`・`researchForm.ts`・`directionDecisionForm.ts`・`adrReferenceForm.ts` | Workspace Directionへ。OutcomeからTarget Project・Storyへの遷移 | S10-02 |
| `features/execution/`（`ExecutionSection`・`TaskDetailPage`・`ClaimHolderSection`等） | Project配下のまま。Workspace→Projectの遷移に接続 | S10-03、S10-04 |
| `features/activity/`・`grant/`・`credential/`・`member/`、`permissions.ts`・`projectAccess.ts`・`useProjectAccess.ts` | scope別の表示と、Workspace / Projectの権限の区別 | S11-01〜03 |
| `styles/main.scss`・`styles/_tokens.scss`・`styles/_mixins.scss`・`components/` | SCSS基盤は既存Project画面に接続済み。Shell・StateCard・FormErrorSummary・ReasonPanel等の既存部品と共通classを再利用する。S09-02でWorkspaceのShell・画面へ接続し、ナビゲーションの`nav-link` mixinとtokenがWorkspace・Projectの双方へ反映されることを実ブラウザで確認済み | S09-01、S09-02 |

## Orchestrator・Ralph

| 対象 | 現況 | 変更 | Task |
| --- | --- | --- | --- |
| `orchestrator/src/config.ts` | `workspaces[]`（`workspaceId`・Workspace Runtime Credentialの`tokenEnv`・Workspace Role用`agentEnv`・manager用`projects[].agentEnv`）。Project単位の`projects[]`は移行手順を示して拒否する | 実装済み | S08-03 |
| `state.ts`・`compassClient.ts` | `get_workspace_orchestration_state({ workspaceId })`をWorkspace Runtime Credentialで読む。Project基準の応答型は削除 | 実装済み | S08-02/03 |
| `plan.ts` | `planWorkspaceDispatches`だけ。key `<workspaceId>:<role>:…`・manager `<workspaceId>:<projectId>:manager:outcome:<outcomeId>`。Targetなし・未完了archived Targetあり→Workspaceのstrategist、active TargetのStory未作成→そのProjectのmanager、全Target評価可能→evaluator。archived Workspace / Projectへは起動しない。Project基準の`planDispatches`は削除 | 実装済み | S08-02、S08-03 |
| `dispatchStore.ts` | 保存形式version 2（keyはWorkspace IDで始まる）。`prune`はWorkspace単位。Project基準のversion 1の記録は引き継がず、そのAgentが動いている間は読込を拒否する | 実装済み | S08-03 |
| `launcher.ts` | Workspace Roleへ`COMPASS_WORKSPACE_ID`と`get_workspace_role_context`、managerへ`COMPASS_WORKSPACE_ID`・`COMPASS_PROJECT_ID`と`get_role_context`の指示を渡す。Workspace Roleには`COMPASS_PROJECT_ID`を渡さない | 実装済み | S08-03 |
| `ralph/bin/ralph-loop`・`backends/compass.sh`・`prompts/*.md`・`examples/config.json` | `projectId`でWork toolsを呼ぶ | 変更なし（Project scopeの実行ループのまま）。Workspaceを所有・選択せず、Workspace要約・関連OutcomeはServerの`get_role_context({ projectId })`から得る（S07-04で接続済み） | S07-04（実装済み）、S08-04（OrchestratorとのE2Eで検証済み） |

## Role・Policy・Skill文書

`roles/strategist.md`・`researcher.md`・`evaluator.md`・`runtime.md`・`manager.md`、`policies/role-policy.md`、`skills/accept-task.md`は`projectId`とProject scopeを前提に書かれている。tool入力を変えるTask（S03-04、S04-01、S06-02、S07-03〜04、S08-01）で、同じTaskの中で該当Roleの文書を更新する。`roles/worker.md`・`reviewer.md`とRalphのpromptはProject scopeのまま。

## schemaと公開契約の切替確認

- S03・S05・S06・S07のschema変更はCREATE定義へ直接反映し、必要なら開発DBを再作成する。旧列・旧tableをデータ変換目的で残さない。
- 空DBの初期化、同じschemaでの再起動、Workspace/ProjectのFKとscope、index・冪等性を検証する。
- Agent・Orchestrator・Ralphの入力と公開入口を揃え、Project IDをWorkspace IDとして扱う別名を作らない。
- S07-01は全Activity書込経路とCHECKを同時に切り替え、S03-01の通知切替より先に完了する。DB再作成後も、業務変更とActivity追記の原子性は必要である。
- S12-01は残った旧列・旧table・migration・互換経路を整理する。関連Taskで除去済みのものを重複実装しない。

## 回帰の根拠になる既存テスト

| 領域 | test file | 主に影響するTask |
| --- | --- | --- |
| Project・archive | `server/tests/projectAdapters.test.ts`・`projectArchive.test.ts`・`projectArchiveUi.test.ts`・`projectForm.test.ts`・`projectOverviewUi.test.ts`・`emptyStateUi.test.ts`・`projectWorkspaceMigration.test.ts`・`workspaceSchema.test.ts`、`packages/organization/tests/project.test.ts`・`updateProject.test.ts`・`projectStrategy.test.ts` | S02 |
| Direction | `intent*.test.ts`・`outcome*.test.ts`・`research*.test.ts`・`initialResearch.test.ts`・`additionalResearch.test.ts`・`directionDecision.test.ts`・`adrHandoff.test.ts`・`strategist*.test.ts`・`researcherMcp.test.ts` | S03 |
| Execution還流・評価 | `executionEvidence.test.ts`・`executionHandoff.test.ts`・`executionPlan.test.ts`・`outcomeEvaluation.test.ts`・`evaluationReplan.test.ts`・`outcomeConfirmed.test.ts`・`runtimeEvents.test.ts`・`lv6ClosedLoop.test.ts`・`workspaceExecutionDirection.test.ts`・`multiProjectOutcomeEvaluation.test.ts` | S04、S05 |
| Work | `packages/work/tests/taskCoordination.test.ts`、`server/tests/execution*.test.ts`（Mcp・Coordination・Operator・WebRead・Ui・Boundary） | S04-03、S12-02 |
| Access | `projectGrant*.test.ts`・`grantForm.test.ts`・`activeRole.test.ts`・`accessCredential.test.ts`・`credentialUi.test.ts`・`human*.test.ts`・`membershipUi.test.ts`・`remoteMcpHumanCommands.test.ts` | S06 |
| Activity・Role Context | `packages/activity/tests/activityStore.test.ts`、`server/tests/activity.test.ts`（Work・Directionの状態変更と同じtransactionのcanonical Activity、`record_activity`）・`activityUi.test.ts`・`agentContext.test.ts`・`instruction.test.ts` | S07 |
| Orchestrator・Ralph | `server/tests/orchestrationState.test.ts`、`orchestrator/tests/*.test.ts`、`ralph/tests/ralph.test.ts` | S08 |
| 入口全体 | `server/tests/app.test.ts`・`frontendApi.test.ts`・`executionBoundary.test.ts`（package間のDB直接操作の検査） | 全Story |

新規に必要なテストは各Taskの受入条件に従う。旧schemaからのmigration専用テストは必須にしない。schema変更で不要になった互換テストは同じTaskで整理し、新規DBからの保存・再起動・scope不一致拒否・Claim・自己レビュー/自己受入禁止・複数Targetと再計画を検証する。
