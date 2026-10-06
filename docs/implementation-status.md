# 現在の実装状況

ソースコードと公開入口に基づく現況。移行後の設計は [Architecture Handoff](../compass-codex-architecture-handoff.md) と [ADR 0001](adr/0001-workspace-project-boundary.md) を参照する。

Workspace・Project・Projectの Repository / Resourceは`packages/organization`が所有する。Workspaceはモデル・保存・application use case（作成・参照・一覧・更新・archive、既存WorkspaceへのProject作成、所属Project一覧）を持つ。公開入口はHuman向けWeb APIの参照（`GET /api/workspaces`・`GET /api/workspaces/:workspaceId`・`GET /api/workspaces/:workspaceId/projects`。Workspace Membershipで認可）だけで、作成・更新・archive・member管理の入口、MCP、Web UIは無い。Projectの参照（Web API・MCP・Role Context）は所属`workspaceId`を返す。全Projectは1つのWorkspaceに所属し（`project.workspace_id`）、Mission・Vision・Principles・Constraintsの正本は所属Workspaceである。既存のProjectの公開契約（Web API・MCP・Role ContextのProjectの入出力にMission等を含む形）は保ち、Projectの作成は戦略値を持つ専用のWorkspaceを同じtransactionで作り、Projectの更新のMission等は所属Workspaceへ書く。Projectのarchiveは、所属Workspaceに他のactiveなProjectが無ければWorkspaceも同じ理由・日時でarchiveする。archivedのWorkspaceは更新（Projectの更新によるMission等の変更を含む）を拒否する。`project`の旧列（`mission`・`vision`）と`project_principle`・`project_constraint`は読み書きしない（`mission`はNOT NULLのため作成時に空文字）。旧列を正本としていたProjectは、server起動時の移行で現在値を所属Workspaceへ一度だけ写す（`project.strategy_migrated_at`）。Workspace自体の作成・archiveはActivityを記録しない。Intent・Outcome・成功条件はWorkspace所有で、`intent.workspace_id`・`outcome.workspace_id`へ保存する。Active IntentはWorkspaceにつき最大1件、OutcomeとIntentのWorkspace一致は複合FKで強制する。Intent/Outcomeのapplication use caseとRepositoryはWorkspace IDを直接受け取り、serverの内部`workspaceDirection`へ組み立てる。Workspace Directionの公開入口・Grant・Credentialは未接続。既存のProject入口とDirection Contextは`projectDirectionAdapter.ts`が所属Workspaceを明示解決し、所属Projectが1件の場合だけ接続する。複数Project（archivedも含む）のWorkspaceでは`CONFLICT`（`reason: workspace_direction_required`）で拒否し、Project権限で共有Directionを公開しない。Intent/Outcomeの応答は`workspaceId`を持ち、`projectId`は持たない。Research・Decision・Evaluation・Runtime event等の保存scopeはProjectのまま。AccessのRole Grant/Credential・OrchestratorはProject単位で動作する。Directionのcanonical ActivityだけはWorkspace単位、Work・Project archive・明示Activityは所属Workspace付きProject単位で保存する。

## 実装済み

| 領域 | 現在の構成・機能 |
| --- | --- |
| 起動 | npm workspaces。`orchestrator/`（`@compass/orchestrator`）はServerと別に実行するBatch、`ralph/`（`@compass/ralph`。bash実装でnpm workspaceはテスト・構文検査用）はServerと別に実行するLoop。`server/`（`@compass/server`）がWeb UI（`server/src/web`、build出力`server/public/`）・`/api`・`/mcp`をHonoで同一portに提供。rootの`npm start`等はroot cwdのまま`server/`のentryを起動 |
| 構成 | `packages/organization`（`@compass/organization`。Workspace・Project・Repository / Resourceのmodel・use case・保存）・`packages/direction`（`@compass/direction`）・`packages/work`（`@compass/work`）・`packages/access`（`@compass/access`。Principal・Role Grant・Credential・Membership・Human認証のuse case・規則）・`packages/activity`（`@compass/activity`。Activityのmodel・use case・保存）・`packages/shared`（`@compass/shared`。汎用errorと入力検証の部品）。transport（OIDC adapter・Cookie・Bearer解決）・DIは`server/src`にある。packageは`src/index.ts`で公開し、serverが配線する |
| 保存 | 単一SQLite file / Kysely。table型・DDLはOrganization・Direction・Work・Access・Activityが各packageに持ち、serverの`Database`型と`initializeSchema`が合成する |
| Organization | Workspace（公開入口はHuman向けWeb APIの参照だけ）・Project・Repository / Resource。Project作成（専用Workspaceと同時、または既存Workspaceへ）・更新・archive・参照・一覧のuse case |
| Direction | Workspace所有のIntent・Outcome・固定成功条件。Research・Decision・Evaluation・ADR参照はProject scope。OrganizationのWorkspace/Project状態・参照はserverが渡すreaderで読む |
| Execution | Story・Task・Claim・Comment・Change Log・Review・Acceptance |
| Human | Google OIDC・Web Session・Project Membership・招待・Web UIでの操作。Workspace Membershipは保存・認可・use caseと、Workspace参照のWeb APIまで（member管理の入口・Web UIは未接続） |
| Agent | Credential・Project Role Grant・Git管理の`roles/`・`policies/`・`skills/`・`knowledge/`からのRole / Skill Context配信 |
| Activity | system / workspace / projectのscopeとID制約。Direction canonicalはWorkspace、Work・Project archive・明示記録は所属Workspace付きProject。Project ActivityのMCP・Web・Role Context接続、Workspace Activityの内部保存・取得 |
| Runtime接続面 | event取得・ack、Execution Evidence還流、Orchestrator向けの現在状態Query、scope付きCredential |
| Orchestrator | `orchestrator/`。Project横断で`get_orchestration_state`を読み、状態判定だけで専門RoleのAgent（設定したshellコマンド）を起動する。dispatch keyの起動記録とprocess lockで並行起動・再起動・再試行の重複を抑止する。Orchestrator停止後に残ったAgentはlease切れ後にprocess groupごと停止（猶予後SIGKILL）を確認してから再試行する。AgentはPIDの記録後に開始合図を受けるまでRoleのコマンドを実行しない。AgentへはRuntime Credentialの環境変数を渡さない |
| Ralph | `ralph/`。`list_tasks`の`availableFor`でWorker / Reviewerの対象を確認し、Claude Code・CodexのAgentを1 Taskずつ起動する。Worker / Reviewerは別Credential（Role別の`tokenEnv`）と`X-Compass-Active-Role`で接続し、同じCredentialの設定は起動を拒否する。AgentへはそのRoleのtokenだけを渡し、起動指示はRole Contextの取得だけでRole手順を含めない。Claimは保持せず、停止したAgentのTaskはClaim期限後に再取得される |

Research Request / Result / Finding / SynthesisとDirection Decision・Evaluationは現在DBに保存する。Intent作成はResearch Requestを作らず、OrchestratorがStrategistを起動してResearchの要否を判断させる。保存先は内容と所有責務で個別に判断し、Project別であることや本文が長いことを理由に一律移行しない。

現在のExecution Role名は`manager` / `worker` / `reviewer`で、統合後も維持する。

Intent/Outcomeの状態変更・成功条件・canonical Activityは同じtransactionで確定し、通知保存に失敗すれば全て巻き戻る。serverの`directionChangeObserver`はActivity投影に加え、`outcome_confirmed`を所属Projectが1件の場合だけ既存Project Runtime eventへ投影する（同じtransaction、Outcome単位の重複防止）。Projectが無い、または複数あるWorkspaceではProject eventを作らない。Workspace Runtime event・Context・Orchestratorの接続はS03-03/04以降の対象で、Workspaceのみの自律実行は未接続・未検証。

## Role / Skill Contextの現行契約

構成資産はrepo直下の`roles/<role>.md`（frontmatterの`skills`で使うSkillを参照）・`policies/role-policy.md`・`skills/<name>.md`（frontmatterに`requiredKnowledge`とnamespace付きの`requiredTools`。`allowRoles`は持たない）・`knowledge/`（Agent System共通知識）に置く。serverの`FileAgentAssetRepository`（infrastructure）がfileとGit revisionを読み、`AgentContextService` / `GetRoleContextUseCase`（`server/src/application/agentContext`）が配信する。

- `get_role_context({ projectId, role })`: 要求RoleのGrantが必要（activeRole指定時は同じRoleに限る）。Role Definition（frontmatterを除いた本文と`skills`）・共通Policy・参照SkillのmetadataとProject基本情報・Project Resources・最近のActivity（`activity`。`list_activities`と同じ形で新しい順に最大20件、summaryとrefsだけ）を返す。Skill本文・Knowledge本文・Activity本文は含めない。`unavailable`は空配列。`get_strategist_context`等のDirection集約は置き換えない
- `list_skills({ status?, role? })`・`get_skill_context({ name })`: 静的な手順書の取得でGrantは不要（remote modeの匿名呼出しには公開しない）。`role`は認可ではなくRole Definitionの参照による絞り込み
- 各応答の`source`は資産を読んだHEADの`revision`と、資産directoryの未commit変更の有無`dirty`（Git管理外はnull）
- 資産の欠落・形式不正（`allowRoles`・namespaceなしのTool・未知のSkill参照・knowledge外のpath）は部分応答を返さず`INSTRUCTION_UNAVAILABLE`。未知のSkillは`NOT_FOUND`
- `get_role_instructions`は互換のため残し、`policies/role-policy.md`（`includeShared`時に先頭）と`roles/<role>.md`をfileのまま返す

## Activityの現行契約

`packages/activity`がActivity（`activity` table）を所有する。追記専用で、更新・削除の経路は持たない。Change Log（Work）・Runtime event（Direction）・Operational Log（stdout）とは別のtableと契約で、Agentの実行単位（`runId`）は持たない。

- 項目: `id`・`cursor`（全体で単調増加）・`scope`（`system` / `workspace` / `project`）・`workspaceId`・`projectId`（DBのCHECKでsystemは両IDなし、workspaceはWorkspace IDのみ、projectは両ID必須。FKで各IDの存在を検証）・`type`（`research.summary`等のdot区切り小文字）・`principalId`・`role`・`summary`（必須、500文字以内）・`body`（任意のMarkdown）・`refs`・`correctsActivityId`・`source`（`recorded` / `canonical`）・`occurredAt`・`recordedAt`。
- `refs`: `project_resource`（Projectに登録済みのRepository・Resourceの`resourceId`と任意の`path`・`revision`）・`url`（http(s)）・Entity（`intent`・`outcome`・`research_request`・`decision`・`story`・`task`・`activity`のid）。成果物の本文は持たない（未知の項目は拒否）。
- `record_activity`: Project scopeの記録。所属Workspace・Project状態・Resource・訂正対象の検証とappendは同じtransactionで行う。欠損を補正せず拒否し、訂正対象は同じscope/Workspace/Projectに限る。PrincipalはBearerから、Roleは入力の`role`（そのRoleのGrantが必要）または`X-Compass-Active-Role`から決める。どちらも無ければ`VALIDATION_ERROR`、activeRoleと異なるRole・Grantの無いRoleは`FORBIDDEN`。archivedのProjectは`CONFLICT`。`runId`・成果物本文等の未知の項目（top-level・ref内とも）は`VALIDATION_ERROR`。同じPrincipal・`requestId`の再送は、Grantの検証後、Project状態・参照Resourceの検査より先に照合し、同内容なら同じActivity（`created: false`）を返す（archive後・参照Resource削除後も同じ）。別内容での再利用は`CONFLICT`。訂正は`correctsActivityId`を持つActivityを追記し、元は書き換えない。
- `list_activities` / `get_activity`: Project scopeだけを返し、Workspace Activityは取得できない。ProjectのいずれかのGrant（activeRole指定時はそのRole）が必要。一覧は本文を含めず`hasBody`を返す。`afterCursor`なしは新しい順で`nextCursor`を次の`beforeCursor`に、`afterCursor`ありは昇順の差分で`nextCursor`を次の`afterCursor`に使う。`principalId`・`role`・`type`・参照（`refKind` + `refId`）で絞り込める。`get_activity`は本文と、そのActivityを訂正したActivity（`corrections`）を返す。
- canonical生成: Workは所属Workspaceを同じtransactionでOrganization readerから解決し、両IDを持つProject Activityを追記する。Workの`KyselyWorkStore`がChangeを追記した同じtransactionで、serverが配線した通知（`workChangeActivityObserver`）からActivityの`recordCanonicalWorkActivity`を呼ぶ。対象は`STORY_CREATED`・`STORY_COMPLETED`・`STORY_CANCELED`・`TASK_CREATED`・`TASK_COMPLETED`・`TASK_REVIEWED`・`TASK_ACCEPTED`・`TASK_REJECTED`・`TASK_CANCELED`で、Claim操作・編集・Story着手は対象外。`role`はChangeの`actorRole`（Human介入は`operator`）。生成元Changeの`cursor`で一意にするため重複せず、Activityを保存できなければ状態変更も確定しない。導入前のChange Logからは遡って生成しない。
- Directionのcanonical生成: 各SQLite repositoryが状態変更と同じtransactionで通知（`DirectionChangeObserver`）し、serverの`directionChangeActivityObserver`はIntent/Outcome通知のWorkspace IDを直接使い、Research/Decision/Evaluation通知だけProject IDから同じtransactionで所属Workspaceを解決して`recordCanonicalDirectionActivity`へ`workspaceId`を渡し、`projectId: null`のWorkspace Activityを追記する。Intent/Outcome通知は`workspaceId`、未切替の通知は`projectId`を持つ判別可能なunion。両IDを同時に持たせない。対象はIntentの作成（`intent.created`）・放棄（`intent.abandoned`）、Outcomeの確定（`outcome.confirmed`。`create_outcome`・`decide_next_outcome`）・取消（`outcome.canceled`）、Research Requestの依頼（`research.requested`。Strategistの追加Researchを含む）・終了（`research.closed`）、Direction Decisionの記録（`decision.recorded`）、Outcome Evaluationの記録（`outcome.evaluated`）。Projectのarchive（`project.archived`）はOrganizationの`SQLiteProjectRepository`が同じtransactionで通知（`ProjectChangeObserver`）し、serverの`projectChangeActivityObserver`が`recordCanonicalProjectActivity`で所属Workspace付きproject scopeに記録する（一意キーは従来と同じ`direction_change:project_archived:{projectId}`）。Intent・Outcome・Projectの文言編集、Research結果・Synthesis、ADR・Execution Evidenceは各recordを正とし対象外。放棄に連動するOutcome・Requestの取消は放棄の1件にまとめる。取消・放棄・停止・archive・判断の理由は`body`に残す。操作者は入口が認可した主体で、MCPは認可したPrincipalと要求Role（Direction管理操作はactiveRole、無ければ`operator`）、Web UIは認証済みHuman（`human:{humanUserId}`・`operator`）、Principalのない呼出し（trusted-local・起動時の補完）は`system`。変更されたrecordと種類で一意にするため`requestKey`の再送・再試行で重複せず、Activityを保存できなければ状態変更も確定しない。導入前の状態変更からは遡って生成しない。
- Human: Web API `GET /api/projects/:projectId/activities`（`beforeCursor`・`limit`）・`GET /api/projects/:projectId/activities/:activityId`はMembership（viewer以上）で認可し、Project詳細の「Activity」sectionで表示する。`project_resource`参照は登録済みのURLとpath・revisionで表示する。Web UIからは記録しない。

## Executionの現行契約

Organizationが所有するProjectを実行境界として共用し、Execution専用のProjectを複製しない。`packages/work`がStory / Task / Claim / Review / Acceptanceを所有する。状態遷移・Claimの排他と期限・自己レビュー / 自己受入の禁止はapplication層（`TaskCoordinationService`）が持ち、保存は`WorkStore` port（Kysely実装は`packages/work/src/infrastructure`）を通す。

Outcomeを参照するStoryは、成功条件・Constraints等の作成時snapshotと相関IDを持つ。相関IDとTaskの`taskKey`によって再送を同じ作業へ収束させる。Work側の受入をOutcome達成とは扱わない。

HumanはExecution一覧・Task詳細・最近の変更を参照でき、editor以上は手動起票・編集・受入・差戻し・取消・Commentを行える。Outcome handoffで管理するStory / TaskはHumanから編集できない。Story / Taskの編集（Web UI・MCPの`edit_story` / `edit_task`）は、内容が変わった場合だけ同じtransactionで`STORY_EDITED` / `TASK_EDITED`をChange Logへ追記し、`payload.changes`に変更前後を残す。MCPの同一`requestId`再送・失敗した編集では記録しない。編集は「最近の変更」とTask詳細の変更履歴に表示する。有効Claimとの競合を拒否し、取消後の古いClaim操作も拒否する。

Project詳細の「Claim保持中」は、既存の`execution`の`activeClaim`だけから、期限内のClaimを持つAgent・Taskを作業中・レビュー待ち・受入待ちに分けて出し、Task詳細へリンクする。期限切れ（`reclaimable`、または表示中に期限を過ぎたClaim）は保持中に含めず、`doing`のTaskを再取得待ちとして件数で出す。取得時刻と再読込を出し、読込中・取得失敗・Claim無しを区別する。Claimは作業権の期限付き保持で、Agentプロセスの稼働を示さない。Role割当・Credentialからは担当を推測せず、Claimを持たないStrategist・Researcher・Evaluatorの状態は出さない。

DirectionとWorkは公開index（`@compass/direction`・`@compass/work`）とapplication portで接続し、DirectionはWorkに依存しない。WorkはProject状態・Role Grantを`WorkStore`の読取port（`ProjectStateReader`・`ProjectGrantReader`）で、Claim・状態遷移と同じtransactionの中で読む。実装はserverが配線し（`server/src/infrastructure/repository/contextAdapters.ts`）、Workは`project`・`project_grant`のtableを直接扱わない。Directionのuse caseが要求するRole・Runtime scopeの認可も、Directionのportへserverの認可serviceを渡す。境界は [executionBoundary.test.ts](../server/tests/executionBoundary.test.ts) で静的に検証する。Workの規則の単体テストは`packages/work/tests/`、Workspace・Projectの単体テスト（Project作成・更新・archive、Mission等のWorkspaceへの読書き、起動時移行）は`packages/organization/tests/`にある。Direction固有のpackage単体テストは無く、Directionの振る舞いは`server/tests/`で検証する。

## Project詳細（Web UI）

Project詳細は`?view=`で「概要」（`overview`。既定・不正値も概要）・「方向」（`direction`）・「実行」（`work`）・「記録」（`records`）・「設定」（`settings`）に分け、表示中のviewのsectionだけを読み込む。Hero（名前・状態・自分のRole）とarchivedの通知は全viewに出し、view切替（`nav`、選択中に`aria-current="page"`）は上端へstickyにする。他viewのTask・Role行へは`?view=work#execution-task-…`・`?view=settings#agent-role-…`で辿り、読込後に移動してfocusする。decodeできないhash（例 `#%`）は無視し、viewを通常どおり表示する。

- 概要: Mission（1行）、現在地（Intent → Outcome → Work → 評価）、次の行動、Claim保持中。Workは`execution`のTaskを未着手・作業中・再取得待ち・レビュー待ち・受入待ち・差戻しの1区分ずつに数え、評価はActive Outcomeごとの`outcomeLoopStage`を先頭5件まで出す。
- 次の行動: 「あなたの操作」（最大3件。Intent登録はActive Intentが無いとき、Outcome登録はActive IntentがありActive Outcomeが無いときだけ。期限内Claimの無い受入待ちの確認、Story起票待ち・着手待ち・レビュー待ち・評価待ちに対する未割当Roleの割当、administratorにはCredentialの無い割当済みAgent）と、「Agentの担当待ち」（Story起票待ち・評価待ち・還流待ちのOutcome、期限内Claimの無い未着手・差戻し・再取得待ち・レビュー待ち・受入待ちのTask）に分ける。権限の無い操作は依頼先を示し、AgentのClaimやOutcome handoffを要する作業をHumanの操作にしない。archivedでは出さない。取得できなかったOutcomeは件数に含めず再読込を出す。現在地のWorkと次の行動は、Claim保持中と同じく表示中にClaimの期限を過ぎた時点で再判定する。判定は`server/src/web/features/project/overview.ts`。
- 方向: Mission・Vision、Intent（Active Outcome・過去のIntent）、Principles・Constraints。
- 実行: Story・Task一覧、起票の導線、最近の変更。
- 記録: Activity、Research、ADR参照、Repositories・Resources。
- 設定: Agent（6 Roleを1つの一覧にし、行を開くと割当・取消。administratorには割当済みAgentのCredentialの有無）、Credential（administratorのみ）、Member・招待、Projectの編集・アーカイブ。

状態badgeは意味ごとのtone（`server/src/web/statusTone.ts`）で色を分ける。要対応（受入待ち・差戻し・評価の未達成・成功条件を満たさない）は塗りのアクセント、待機（未着手・未評価・Execution未接続・受諾待ち）は枠線、進行中（作業中・レビュー待ち・Active・Execution中）は青、完了（受入済み・達成・満たす・有効なCredential）は淡い緑、終了・分類ラベル（取消・過去のIntent・Activityの種別等）は控えめ、警告（期限切れClaimの作業中・再取得待ち・Evidence不足・期限切れ）は淡い赤の枠線にする。色は`styles/_tokens.scss`の`--tone-*`で定義し、文字と背景はWCAG AA（4.5:1以上）を満たし、badgeには常に状態のラベルを併記する。動きはview切替と`details`展開の短いfade（約180ms）とbadge色の変化に限り、Claim保持・Role割当に点滅・脈動・回転・カウントダウンを使わない。`prefers-reduced-motion: reduce`ではanimation・transitionを止める。

Web UIのstyleはSass（SCSS）で`server/src/web/styles/`に置き、`main.scss`から`_tokens`（色・文字・余白・角丸・影・動き・焦点表示のCSS変数と狭い画面のbreakpoint）→`_base`（要素の既定値・焦点表示・reduced-motion）→`_layout`（Shell・見出し・view切替）→`_components`（ボタン・StateCard・状態badge・区画・一覧等の画面共通class）→`_features`（機能固有の配置）の順に読み込む。共通値はtokenで定義し、共通の型は`_mixins.scss`のmixin（narrow・focus-ring・caps-label・panel・list-item等）で再利用する。文字色は背景（paper・surface・raised・note）に対して4.5:1以上、入力欄の枠と焦点表示は3:1以上とする。Tailwind等のutility CSSは使わない。

空状態・読込失敗・未定義URLの表示はWeb UI共通とする。空の一覧は誰が登録・起票するか（Strategist・Researcher・Manager等）を示し、Humanが登録できない場合（archived・権限なし）は導線の代わりに理由と依頼先を出す。読込失敗は、存在しない・閲覧権限の無い対象を画面ごとの文言で、接続失敗・サーバー障害・解釈できない応答をサーバーの英語文言ではなく再試行の案内で示す（`server/src/web/api.ts`の`classifyError`・`loadFailureMessage`）。未定義のURLはログイン後に404画面を出し、Project一覧と、Compass内から遷移してきた場合だけ直前の画面へ戻る導線を出す。

## Accessの現行契約

`packages/access`がAgentのRole Grant・Credential、HumanのProject Membership・Workspace Membership・招待・Session・ログイン試行を所有し、認可（`ProjectAuthorizationService`・`RuntimeAuthorizationService`・`HumanProjectAuthorizationService`・`HumanWorkspaceAuthorizationService`）を提供する。Human Membership・Agent Grant・Runtime Credentialのscopeは別のモデル・tableで扱う。

Workspace Membership（`workspace_membership`）はProject Membershipと同じRole（owner / administrator / editor / viewer）で、Workspaceの閲覧（viewer）・Direction管理（editor）・Mission等の更新と既存WorkspaceへのProject作成（administrator）・archiveとmember管理（owner）を権限表`humanWorkspacePermissions`で認可する。未所属・取消済み・存在しないWorkspaceは404、Role不足は403。最後のownerの降格・取消は`LAST_OWNER`、archivedのWorkspaceへのMembership変更・Project作成は`CONFLICT`（`workspaceStatus: archived`）で拒否する。Project MembershipとWorkspace Membershipは相互に継承しない（Workspace memberでもProjectのWorkは操作できず、Project memberでもWorkspaceは操作できない）。memberの追加対象は、そのWorkspaceに所属するProjectの有効なMemberだけ（emailでのHuman検索は公開しない）。初期memberは、Actor付きのWorkspace・Project作成で作成者をownerにする（既存WorkspaceへのProject作成ではProjectのownerだけ）。既存DBでは、server起動時にWorkspace Membershipの行が1件も無いWorkspaceへ、所属Projectの有効なProject Membershipを同じRoleで一度だけ写す（`backfillWorkspaceMemberships`）。owner不在のWorkspaceは、owner不在Projectと同じくplatform ownerのログイン時に補完する。use caseはserverの`createApplicationServices`の`human`へ配線済み。Web APIはWorkspaceの参照（一覧・詳細と`myRole`・所属Project一覧。viewer以上）だけを公開し、所属Project一覧はpurpose・Repository・Resourceの参照を返す（Mission等はWorkspaceの応答を参照し、Projectごとに複製しない）。Workspace memberは所属Project一覧を見られるが、Project詳細・WorkはProject Membershipで認可する。作成・更新・archive・member管理のWeb API、Web UIの入口は無く、Directionの変更は引き続きProject Membershipで認可する（Workspace Membershipへの切替はDirectionのWorkspace scope化とS06-04）。Claimの所有・期限・状態遷移・自己レビュー / 自己受入の禁止はWorkが強制し、Accessへ移さない。transport（OIDC adapter・Session Cookie・`Authorization`の解決）はserverの`server/src/auth`にある。

操作Contextの`activeRole`は、MCP・Runtime向けAPIのrequest header `X-Compass-Active-Role`で受け付ける（serverの`resolveActiveRole`）。headerがあれば、serverはrequestごとに`forActiveRole`で認可をそのRoleに固定したservice（Accessの`ProjectAuthorizationService`・Workの`TaskCoordinationService`と、それらで認可するDirection・Runtimeのuse case）を使い、`principalId + projectId + activeRole`のGrantだけで認可する。MCPのDirection参照・`list_projects`は、remote modeに加えtrusted-localでもactiveRole指定時はそのRoleのGrantを要求する（headerなしのtrusted-localは互換としてGrantを問わない）。Principalなしでの指定はProject scopeのtool（管理操作の`update_project`・Intent管理を含む）で`UNAUTHENTICATED`。trusted-localの`create_project`はProject作成前の操作でGrantの対象外のため、activeRoleの指定に関係なく実行できる。他Roleのtool・Grantの無いactiveRoleは`FORBIDDEN`。Accessが拒否する場合のうち、activeRoleと異なるRoleのtool、Project参照・管理操作でactiveRoleのGrantが無い場合は応答の`error.activeRole`にactiveRoleを返す（MCP・Runtime向けAPIとも`ForbiddenError`のdetailsを`error`へ展開する）。activeRoleと同じRoleのtoolでGrantが無い場合（`requiredRole`のみ）と、WorkのTask操作の拒否（`CoordinationError`）には含めない。未知の値は400。職務分離（Strategist等のGrantを持つPrincipalへの管理操作の拒否）は緩めない。headerなしは互換として操作ごとに必要Roleを検査し、拒否はRalph移行後に別途判断する。Runtime Credentialはheaderに関係なくscopeで認可する。`command_receipt.active_role`（nullable。既存行はNULL）に実行時のactiveRoleを保存し、同じ`principal_id + tool_name + request_id`を別のactiveRole（headerなしを含む）で再送すると`IDEMPOTENCY_CONFLICT`にする。自己レビュー・自己受入の禁止はPrincipal単位でWorkが強制し、Role切替では回避できない。Human向けWeb APIはMembershipで認可し、headerを読まない。

Accessは`project`・`workspace`のtableを直接読まない。archive判定・Projectの存在・owner不在Projectの補完に使うProject一覧は`ProjectStateReader` port、Workspaceのarchive判定・Workspace一覧・所属Project一覧は`WorkspaceStateReader` portで読み、Membership・Grant・Credentialの書込と同じtransactionで検査する。Workspace・Project作成時の初期owner Membershipは、OrganizationのWorkspace・Project作成（`SQLiteWorkspaceRepository`・`SQLiteProjectRepository`）のtransactionの中で、serverが`OwnerMembershipWriters`として渡したAccessの`writeWorkspaceOwnerMembership`・`writeProjectOwnerMembership`が書く。いずれもserverが`contextAdapters.ts`で配線する。AccessがOrganizationから使うのは公開indexのuse case（`GetProjectUseCase`・`ListProjectsUseCase`・`GetWorkspaceUseCase`・`ListWorkspacesUseCase`・`CreateWorkspaceProjectUseCase`。所属Project一覧の`ListWorkspaceProjectsUseCase`はserverが`HumanWorkspaceAuthorizedUseCase`で包む）・型（`ProjectDetail`・`ProjectStatus`・`Workspace`・`WorkspaceStatus`）・`ProjectArchivedError`・`WorkspaceArchivedError`だけで、AccessはDirection・Workに依存せず、OrganizationはAccessに依存しない。

## 構造移行後の検証範囲

- Workspace参照（`server/tests/workspaceReference.test.ts`）: 新規のSQLite fileへWorkspace・Project・Resource・Membership・Grantを保存し、DBを閉じて同じschemaを再初期化したapplicationで、Web APIとMCPのProject参照、所属Project一覧、archivedの読取、Workspace/Project権限の非継承を検証する。HTTP入口は`app.request`で呼び、Serverプロセスの再起動や実ブラウザの検証とは区別する。
- 自動テスト（`npm test`）: Lv6閉ループ（`server/tests/lv6ClosedLoop.test.ts`。Intent→Research→Outcome→Work→Review / Acceptance→Evaluation→次の判断、固定成功条件のsnapshot、`insufficient_evidence`、別Principal、再起動・重複配送）、`server/src/main.ts`の同一portでのWeb UI・API・MCP、Orchestrator・Ralphの独立プロセスとしての起動・再起動・重複起動抑止・別Credentialを検証する。起動テストは一時directoryをcwdにし、親の`COMPASS_*`・`PORT`を渡さず空きportを使い、ローカルの`.env`と既存portから隔離する。
- Activity scope（`server/tests/activity.test.ts`・`packages/activity/tests/activityStore.test.ts`）: 3 scopeのID制約・FK・cursor/filter、複数ProjectのDirection/Work/archive/明示記録の分離、保存失敗・transaction内の所属欠損によるrollback、Project入口からのWorkspace履歴の取得拒否、新規SQLite fileを同じschemaで再初期化した際の保存を検証する。旧Activity schemaの変換・旧履歴の保全は検証対象外。

## 未実装・未接続・未検証

- `scope=system`のActivityは保存形式だけで、記録・参照の入口（MCP・Web）は無い。Workspace Activityはcanonical生成と内部storeの`listWorkspace`・`maxWorkspaceCursor`・`find`まで。Workspaceの明示記録・公開API/MCP・Web UI・Role Contextは未接続（S07-02〜04・S11-01）。旧Activity schemaは変換せず開発DBを再作成する。
- OrchestratorはAgentへ`get_role_context`の取得を指示して起動するが、実Agent（Claude Code・Codex等）を起動した運用は未検証。結合テストの起動先はfixture。Execution Evidenceの還流は行わない。複数ホストでの並行実行の重複抑止はない。
- RalphがClaude Code・Codexの実Agentを起動してTaskを処理するループは未検証。結合テスト（`ralph/tests/ralph.test.ts`）の起動先はfixture。実CLIはMCP接続のheader（Authorization・`X-Compass-Active-Role`）の送信だけを手動で確認した。remote modeのAgent Credentialでの接続は自動テストの対象外。
- 実RuntimeによるAgent起動と継続したLv6自律運転は未接続・未検証。`server/tests/support/lv6Runtime.ts`等のfixtureを自律運転の実証としない。
- 実Googleとの接続確認は自動テストの対象外。

## 現在のRuntime API

`fetch_runtime_events` / `ack_runtime_event`は現在利用可能。eventの取得・ackにはconsumer単位のcursorと配送状態がある。`list_changes`はExecutionの変更を取得し、`record_execution_evidence`はサーバーが現在状態から導出した結果とEvidence参照をDirectionへ還流する。

これらは現在の接続契約である。Orchestratorはeventではなく`get_orchestration_state`（Runtime Credentialのscope `runtime:state:read`、trusted-localはruntime Grant）の現在状態で起動を判断し、Activity cursor・event cursorをworkflow checkpointにしない。応答はProject・Active Intent・Outcome（Work件数・還流済み要約・最新Evaluationと判断の有無）・Research Requestの状態とIDだけで、本文を含まない。既存Runtime APIをActivityとして流用しない。
