# 相談（Collaboration）

Agentが既存の要件・方針・権限の範囲で決められない問題をHumanへ問い、会話と結論をCompassへ残す。所有Contextは`packages/collaboration`（[ADR 0002](adr/0002-collaboration-context.md)）。Project相談とWorkspace相談、閲覧できる全scopeの横断一覧、Project相談でのTask単位の相談待ち・Manager応答起動・自動再開、Workspace相談のStrategist応答起動、Project・Workspace相談の結論から仕様・Policy・ADRの文書反映Taskへの引継ぎと受入済み成果物の参照までを接続する。

## scope

| scope | 決定対象 | 保持するID | 応答・結論整理・取消のAgent | 参照できる関連先 |
| --- | --- | --- | --- | --- |
| `project` | Projectの要件・設計 | 所属Workspace・Project | Manager | `url`・`project_resource`・`task`・`story`・`consultation`（同じProject） |
| `workspace` | WorkspaceのDirection（Intent・Outcome・優先順位等） | Workspace（Projectなし） | Strategist | `url`・`intent`・`outcome`（`intentId`付き）・`consultation`（同じWorkspace） |

scopeは決定対象の所有で決め、影響するProject数では決めない。相談は自分のscopeでだけ見つかり、Project相談をWorkspaceのIDで、Workspace相談をProjectのIDで指しても`NOT_FOUND`。scopeをまたぐ自動転送・親子相談は作らず、別scopeの判断は別の相談として作り、権限のある相談・成果を参照する。DBは`scope`と`project_id`の有無を一致させる。

## 保存するもの

| 記録 | 内容 |
| --- | --- |
| Consultation | scope・所属Workspace・Project（Project scopeだけ）、タイトル、判断したいこと（`question`）、進めない理由（`blockingReason`）、選択肢（`options`。`label`・任意の`description`）、推奨（`recommendation`）、影響（`impact`）、参照（`refs`）、状態、版（`revision`）、方針変更元（`supersedesConsultationId`）、起票者、取消の理由・主体・日時 |
| Message | 相談内の順序（`sequence`）、記録主体（`author`）、本文、訂正元（`correctsMessageId`）、発言で進んだ版。追記だけで書き換えない |
| Resolution | 相談につき1件。結論・判断の根拠・適用範囲・採用した選択肢（`selectedOption`）・根拠の発言（`basisMessageIds`）と版（`basisRevision`）・判断の由来（`source`）・記録主体 |
| 応答lease | 相談ID・入力版・保持Principal・期限（5分）・解放日時。TaskのClaimとは別 |
| 文書反映の依頼（Follow-up） | 結論・種類（`adr` / `specification` / `policy`）・反映担当Project・Repository・文書反映Task（Work）・目的・決定内容・根拠・検証方法・元Taskの再開の依存理由（`resumptionDependency`）・依頼主体。同じ相談・種類・Project・Repositoryにつき1件 |
| 成果物参照（Artifact） | 依頼・受入済みTask・Repository・Repository内の相対path・完全なcommit SHA・任意のPR URL・記録主体。同じ依頼・path・commitにつき1件。本文は持たない |
| 受付記録 | 主体・操作・`requestId`ごとの入力hashと結果 |

記録主体（`author`・`recordedBy`・`createdBy`・`cancellation.by`）は`kind`（`human` / `agent`）・`principalId`・`role`で、入力からは受け取らない。Humanは`human:{humanUserId}`・`operator`、AgentはBearerのPrincipalと認可したscopeのRole（ProjectはExecution Role、WorkspaceはDirection Role）。

参照は`{kind:'url', url}`と、Projectは`{kind:'project_resource', resourceId, path?, revision?}`・`{kind:'task'|'story'|'consultation', id}`、Workspaceは`{kind:'intent', id}`・`{kind:'outcome', intentId, id}`・`{kind:'consultation', id}`。参照先は相談と同じscopeのものだけを受け付け（別scopeの種類・別Project/Workspaceの対象は`VALIDATION_ERROR`）、相談を閲覧できるHumanは参照先も閲覧できる。Repository / Docsの本文は複製しない。

## 状態と版

| 状態 | 意味 | 遷移 |
| --- | --- | --- |
| `waiting_human` | Humanの判断待ち | 作成時。Agentの回答・追加質問の後 |
| `waiting_agent` | Humanの新しい返信へのAgentの応答待ち | Humanの返信の後（`waiting_agent`中の追加返信も同じ） |
| `resolved` | 結論がある | 結論の保存と同じtransaction |
| `canceled` | 不要になった相談 | 理由付きの取消 |

版は作成時1で、発言・結論・取消のたびに1つ進む。解決・取消後は返信・結論・取消を`CONFLICT`（`conflict: CONSULTATION_CLOSED`）で拒否する。方針の変更・訂正は、解決・取消済みの相談を`supersedesConsultationId`で参照する新しい相談とする（未解決の相談は参照できず`SUPERSEDED_NOT_CLOSED`）。

## Agentの応答の契約

1. `get_consultation`で`revision`と会話を読む。
2. `acquire_consultation_lease`（`inputRevision`=現在の版）で応答leaseを取る。`waiting_agent`の現在の版にだけ発行し、他Principalの有効なleaseがあれば`LEASE_HELD`、古い版は`STALE_REVISION`、Humanの返信待ちは`NOT_WAITING_AGENT`。同じPrincipalの再取得は期限を延ばして同じleaseを返す。
3. `reply_consultation`（回答・追加質問）または`resolve_consultation`（Projectはmanager、Workspaceはstrategistだけ）へ`leaseId`と`expectedRevision`を渡す。応答中にHumanが追加で返信すると版が進み、古い版の応答・解決は`STALE_REVISION`で拒否される。期限切れは`LEASE_EXPIRED`、leaseを持たない・使用済みは`LEASE_NOT_HELD`。応答を保存するとleaseを解放する。
4. `requestId`は主体・操作ごとに一意にする。同じ`requestId`・同じ入力の再送は、その後に状態が変わっていても保存済みの結果を返し、別の入力での再利用は`IDEMPOTENCY_CONFLICT`。

拒否はいずれも`CONFLICT`で、`conflict`・`consultationId`・`currentRevision`・`consultationStatus`を返す。OrchestratorはProject Runtime Credentialで`get_project_consultation_state`を読んでManagerを、Workspace Runtime Credentialで`get_workspace_consultation_state`を読んでStrategistを、相談ID・入力版ごとに起動する。応答leaseは起動されたRoleが自身のAgent Credentialで取得する。processの正常終了だけでは返信を処理済みにせず、同じ入力版が未処理なら既存backoff・試行上限で再試行する。Agentの応答手順は`skills/respond-consultation.md`。

## 結論と判断の由来

| 由来 | 入口 | 記録主体 | 条件 |
| --- | --- | --- | --- |
| `human_decision` | Web API `POST .../resolution`（administrator以上） | Human | 表示した版（`expectedRevision`）が現在の版。`waiting_human` / `waiting_agent`のどちらでも記録でき、根拠の発言は任意 |
| `agent_summary` | MCP `resolve_consultation`（Projectはmanager、Workspaceはstrategist） | Agent | 応答leaseと現在の版。`basisMessageIds`にHumanの発言を1つ以上含む |

由来は入口と記録主体から決め、入力では指定させない（MCPで`source`等の未知の項目は`VALIDATION_ERROR`）。DBも由来と記録主体の組を制約する。Humanの明確な返信を根拠に応答Roleが結論を保存でき、再承認は求めない。通常の許可・既存方針内の判断を相談にする手順は設けない。

## 認可

| 操作 | Human（Project相談はProject Membership、Workspace相談はWorkspace Membership） | Agent（Project相談はProject Execution Role Grant） | Agent（Workspace相談はWorkspace Direction Role Grant） |
| --- | --- | --- | --- |
| 一覧・詳細 | viewer以上（`project.read` / `workspace.read`） | manager / worker / reviewer | strategist / researcher / evaluator |
| 作成 | なし | manager / worker / reviewer | strategist / researcher / evaluator |
| 返信 | editor以上（`consultation.reply`） | manager / worker / reviewer（応答lease） | strategist / researcher / evaluator（応答lease） |
| 結論 | administrator以上の明示決定（`consultation.decide`） | managerの結論整理（応答lease） | strategistの結論整理（応答lease） |
| 取消 | administrator以上（`consultation.decide`） | manager | strategist |
| 応答待ちの読取り | なし | Project Runtime Credential（`runtime:state:read`） | Workspace Runtime Credential（`runtime:state:read`） |
| 文書反映の引継ぎContext・依頼・成果物参照の登録 | なし（詳細で参照だけ） | 反映担当Projectのmanager（文書反映TaskはそのProject Grantで起票） | なし（Workspace相談も、所属Projectのmanagerが左の列の権限で行う） |

Project MembershipとWorkspace Membership、Project GrantとWorkspace Grant、Project Runtime CredentialとWorkspace Runtime Credentialは互いに継承しない。Project MembershipだけのHumanは同じWorkspaceの相談を読めず、Workspace MembershipだけのHumanは未所属Projectの相談を読めない。Humanは未所属・存在しないscope・別scopeの相談IDを404で区別しない。AgentはscopeのGrantが無ければ`FORBIDDEN`、別scopeの相談IDは`NOT_FOUND`、scopeに属さないRole（Project相談のstrategist等）は`FORBIDDEN`。AgentはactiveRole（`X-Compass-Active-Role`）または`role`入力でRoleを決め、どちらも無い記録は`VALIDATION_ERROR`。archivedのProject・Workspaceは参照だけでき、記録は`CONFLICT`（`projectStatus` / `workspaceStatus: archived`）。

## 横断一覧

`GET /api/consultations`は、呼出しHumanの有効なProject Membershipを持つProjectのProject相談と、有効なWorkspace Membershipを持つWorkspaceのWorkspace相談を、更新の新しい順（同時刻はID順）に返す。

| query | 内容 |
| --- | --- |
| `status` | `waiting_human`（既定）・`waiting_agent`・`resolved`・`canceled`・`all` |
| `scope` | `project`・`workspace`（省略で両方） |
| `projectId` | そのProjectのProject相談だけ（Workspace相談を含めない） |
| `workspaceId` | そのWorkspaceのWorkspace相談と、閲覧できる所属ProjectのProject相談 |
| `limit`・`cursor` | 1〜100件（既定30）。続きがあれば応答の`nextCursor`を`cursor`に渡す |

絞り込み・件数・ページングは認可済みの集合に対して行う。閲覧できないProject・Workspaceを指定しても拒否せず空を返し、題名・件数・存在を区別させない。不正な値は400。

## 公開入口

Web API（Human。Session・CSRF）。`:scopePath`は`/api/projects/:projectId`（Project相談）または`/api/workspaces/:workspaceId`（Workspace相談）:

| method・path | 内容 |
| --- | --- |
| `GET /api/consultations` | 横断一覧（上記）。`{ consultations, nextCursor }` |
| `GET :scopePath/consultations?status=` | scopeの一覧（更新の新しい順。`status`省略で全件）。Workspaceの一覧に所属Projectの相談は含めない |
| `GET :scopePath/consultations/:consultationId` | `consultation`・`messages`・`resolution`・`responder`（有効な応答leaseの保持者・期限）・`followups`（文書反映の依頼・反映状況・Task・Repository・成果物参照）・`waitingTasks`（この相談を待つTaskの状態・段階・待機状態。Project相談だけ） |
| `POST .../messages` | 返信`{ body, correctsMessageId?, requestId }`（201） |
| `POST .../resolution` | 明示決定`{ conclusion, rationale, applicability?, selectedOption?, basisMessageIds?, expectedRevision, requestId }`（201） |
| `POST .../cancel` | 取消`{ reason, expectedRevision, requestId }` |

MCP（Agent）: `create_consultation`・`list_consultations`・`get_consultation`・`acquire_consultation_lease`・`reply_consultation`・`resolve_consultation`・`cancel_consultation`、文書反映の`get_consultation_handoff_context`・`request_consultation_followup`・`record_consultation_artifact`（後述）。文書反映以外は`projectId`（Project相談）と`workspaceId`（Workspace相談）のどちらか一方を受け取り、両方・どちらも無い入力は`VALIDATION_ERROR`。Humanの明示決定のtoolは無い。Runtime向けの`get_project_consultation_state`（Project Runtime Credential）・`get_workspace_consultation_state`（Workspace Runtime Credential。所属Projectの相談を含めない、archivedは空）は相談ID・未処理の入力版だけを返し、会話本文を返さない。

Web UI:

- 横断一覧「判断待ち（すべて）」（`/consultations`。サイドバーの下部から開く）: 状態・scopeの切替、Workspace・Projectの選択をURLのqueryで表し（既定はHumanの判断待ち・全scope）、行に所属（`Project · 名前` / `Workspace · 名前`）を出す。続きは「さらに表示」。名前は閲覧できるProject・Workspaceの一覧から引く。
- scopeの一覧: Project詳細の「判断待ち」view（`?view=consultations`）とWorkspaceの「判断待ち」（`/workspaces/:workspaceId/consultations`）。`?status=`で絞り込み、既定はHumanの判断待ち。
- 相談詳細（`/projects/:projectId/consultations/:consultationId`・`/workspaces/:workspaceId/consultations/:consultationId`）: 上段に質問・選択肢・推奨・影響・参照（Task・Story・Intent・Outcome・相談は画面へ、Resource・URLは正本へ）、下段に会話（Humanの発言とAgentの発言を帯の色と文言で区別）と返信、結論または取消の理由を出し、開いている間は15秒ごとに読み直す。導線はscopeのMembershipのRoleとscopeの状態で出し分け、拒否はserverが行う。
- 相談詳細は、結論の下に「文書への反映」（反映状況・種類・反映先Repository・文書反映Task・目的・元Taskの再開条件・成果物のpath/commit/PR。Workspace相談では反映担当Projectも）を出し、Project相談では「この相談を待つTask」（Taskの状態・待機状態・保持した段階・失敗理由、Task詳細へ）も出す。文書の本文は出さない（`ConsultationFollowupSection.tsx`）。

## 専用環境での公開操作による確認

既存DBを使わず、新しい専用ディレクトリの`COMPASS_DB_PATH`、loopbackの`COMPASS_PUBLIC_ORIGIN`と`PORT`、`COMPASS_AUTH_MODE=trusted-local`、`COMPASS_INITIAL_OWNER_EMAIL`を設定してbuild後のserverを起動する。開発用WachaのMCPとは接続先を分ける。

1. 初期ownerが開発用ログインし、Web UIまたはSession・CSRF付きWeb APIでWorkspace（`POST /api/workspaces`）、Project（`POST /api/workspaces/:workspaceId/projects`）を作成する。
2. ownerがProjectの招待（`POST /api/projects/:projectId/invitations`）をadministrator・editor・viewerへ発行し、それぞれ別ブラウザContextで招待リンクからログイン・受諾する。未所属Humanは別Projectの招待で用意する。Workspace MembershipはProjectから継承しない。
3. ownerがProjectのGrant（`POST /api/projects/:projectId/grants`）を別Principalのworker・reviewer・managerへ付与する。専用originの`/mcp`でBearer Principalと`X-Compass-Active-Role`を指定する。
4. workerが`create_consultation`で質問・選択肢・推奨・影響を登録する。HumanがProjectの「判断待ち」から詳細を開き、editorが通常返信する。managerが詳細を読み、現在の版のleaseを取得し、HumanのMessageを根拠に`resolve_consultation`で結論を整理する。
5. 再読込・同schemaでのserver再起動後に会話と結論が保持され、`agent_summary`とHumanの発言が区別されることを確認する。Humanの明示決定はadministratorのWeb UIから別相談で確認する。
6. viewerの書込拒否、未所属・別Projectの404、古い版・他Principalのlease・期限切れの拒否、同じ`requestId`の再送を確認する。Desktopと狭い画面の画像を保存し、空・読込・通信失敗・権限不足を確認する。読込遅延や通信失敗の模擬は表示検査だけに用い、保存・認可の成功の証拠にはしない。

Workspace相談は、ownerがWorkspace（`POST /api/workspaces`）とWorkspace Grant（`POST /api/workspaces/:workspaceId/grants`）のstrategist / researcherを用意し、Workspace Membership（viewer・editor・administrator）とProject MembershipだけのHumanを分けて同じ流れを確認する。Strategistの起動はWorkspace Runtime Credentialを設定したOrchestrator（[Orchestrator](../orchestrator/README.md)）で行う。

回帰テストは`node --import tsx --test packages/collaboration/tests/consultation.test.ts server/tests/consultation.test.ts server/tests/workspaceConsultation.test.ts server/tests/consultationUi.test.ts`、UI構造検査は`npm run check:ui`。テスト内の時刻差し替えでlease境界を検査することと、実環境で期限を待つ確認は区別する。専用serverは確認後に停止する。

## Taskの待機と自動再開（Project相談）

Workが`task_consultation_wait`にTaskごとの待機相談参照（ID・版・結論ID）、元の`work` / `review` / `acceptance`段階、Principal・Role、要件版、保存済みRuntime情報、`waiting` / `ready` / `resuming`と失敗理由を保持する。会話・結論本文はCollaborationだけに置く。相談の準備状態はserverが同じtransactionで配線する`ConsultationReadinessPort`から読み、WorkはCollaborationのtableを読まない。

| MCP | 認可・契約 |
| --- | --- |
| `wait_for_consultation` | 現在Claim所有者と段階のProject Role。`taskId`・`claimId`・`consultationIds`・`reason`・`runtime`・`requestId`。同じProjectの未解決のProject相談だけ（Workspace相談では待機しない）。Runtime情報を保存後、statusを保持したままClaimを解放する |
| `list_consultation_resumptions` | Project Execution Role。自身のPrincipal/activeRoleが保持する保存済み実行だけを全件照合。全相談の解決/取消確認・現在要件版を確かめて再開候補を返す |
| `resume_consultation_task` | 元Principal・Role。実際の`runtime`を指定し、保存時のworktree/Context・PR・HEAD・fingerprintと一致することを確認。元段階の新Claimを排他的に取得する |
| `confirm_consultation_continuation` | manager。取消の不要理由/継続方針、現在の`expectedRequirementVersion`と全相談の`consultationRevisions`を確認。未解決相談は解決扱いにしない |
| `get_project_consultation_state` | Project Runtime Credentialの`runtime:state:read`（trusted-localは既存runtime Grantも可）。相談ID・未処理入力版だけ。会話本文を返さず、Workspace Credentialから継承しない |

`runtime`は`worktreePath`・`contextPath`・`headSha`・`sourceFingerprint`・`pullRequest`（null可）・`verificationRefs`。外部成果物はRuntimeが先に保存する。要件版はTask本文・段階・差し戻し理由・Storyの要件/snapshotから作り、ソート変更や待機照合で変えない。

待機関係があるTaskは`availableFor`と直接Claimの双方から除く。別Workerによる取得を防ぎ、他Task/Roleの実行を継続する。Human返信だけではTaskを再開しない。全相談の解決を照合し、取消はManagerが理由・継続方針を確認するまで保持する。要件変更にもManagerの現在版の確認が必要。版の古い確認を拒否する。

製品Ralphは同じ`projectRoot`でpollingし、保存済みContextと未commit/未追跡成果物を検査する。OSのworktree lockを保持し、元段階のClaim再取得後にAgentを起動する。Runner停止時も旧Agentが持つlockが残るため同時起動しない。再開したAgentは結論・現在要件・PR/SHAを再読込し、旧blocked結果を再送せず、古い検証を変更後のSHAへ無条件適用しない。成果物版の照合が失敗した場合は破棄せず失敗理由を報告する。Task詳細は待機/再開状態・元段階・相談導線・失敗理由を表示する。

設定・運用は[Orchestrator](../orchestrator/README.md)と[Ralph](../ralph/README.md)。実行手順はRoleから参照する`skills/consultation-task-resumption.md`を正本とする。稼働中agent-foundation版Ralph/Wachaは開発系の別実行システムで、本契約はCompass製品の`/mcp`と製品側`ralph/`が所有する。

## 結論の文書反映

相談の結論を仕様・Policy・ADRへ反映する必要があるとき、反映担当Projectのmanagerが文書反映を依頼する。反映の要否・種類・文書の内容はAgentが判断し、Serverは意味を判定しない。長く効く構造・技術選択で代替案とトレードオフを伴うものを`adr`、継続する要件を`specification`、運用ルールを`policy`とする。通常の実行許可・既存方針内の判断・一時的な確認・UI寸法等を相談・ADRへ送らず、Humanへの追加承認工程は設けない。

反映担当Projectは、Project相談ではそのProject、Workspace相談ではそのWorkspaceに所属するProjectとする。相談の所有scopeは変えず、依頼・参照は相談に属する。Work Taskの起票はProject GrantのRoleだけが行うため、Workspace相談の結論もStrategistではなく所属Projectのmanagerが、そのProjectのmanager Grant（activeRole `manager`）で引き継ぐ。Workspace Grantは要らず、使わない（Outcomeの`get_outcome_handoff_context`と同じ引継ぎの形）。どのProjectが反映するかはAgentが結論から判断し、Serverは自動で転送しない。

| MCP | 認可・契約 |
| --- | --- |
| 共通 | `projectId`（反映担当Project。そのmanager Grantが必要）と`consultationId`。Workspace相談では`workspaceId`も渡す（無ければ`projectId`のProject相談として探す）。反映担当Projectが存在しない・相談の所属に含まれない（別Project・別WorkspaceのProject）は`NOT_FOUND`で相談の存在を区別しない。archivedのProject・Workspaceへの記録は`CONFLICT`。manager以外・Direction Roleは`FORBIDDEN` |
| `get_consultation_handoff_context` | 解決済みの相談の質問・選択肢・推奨・参照と結論、そのProjectが担当する依頼と反映状況。会話本文は返さない。未解決は`CONFLICT`（`CONSULTATION_NOT_RESOLVED`） |
| `request_consultation_followup` | 解決済み（`resolved`）の相談だけ（未解決は`CONFLICT` `CONSULTATION_NOT_RESOLVED`）。`kind`・反映担当Projectに登録された`repositoryId`・`title`・`purpose`・`decision`・`rationale`・`verification`・任意の`storyId`・`resumptionDependency`。Workの通常の起票処理（Project Grant・activeRole・Projectの状態・Change Log・canonical Activity）で文書反映Taskを同じtransactionで起票し、Task本文へ相談ID・結論ID・反映先・目的・決定内容・根拠・検証方法を書く。同じ相談・種類・Project・Repositoryへの依頼は`requestId`によらず同じ依頼・Taskを返し、内容が違えば`CONFLICT`（`FOLLOWUP_EXISTS`） |
| `record_consultation_artifact` | 依頼の反映担当Projectのmanagerだけ（別Projectからは`NOT_FOUND`）。`followupId`と、その依頼の`taskId`・`repositoryId`（違えば`VALIDATION_ERROR`）、Repository内の相対`path`、完全な40桁の`commitSha`、`pullRequestUrl`（null可）。文書反映Taskが`accepted`でなければ`CONFLICT`（`FOLLOWUP_TASK_NOT_ACCEPTED`）。path・commit・PRがそのTaskの受入成果物（後述）のいずれとも一致しなければ`CONFLICT`（`ARTIFACT_NOT_ACCEPTED`）。同じ依頼・path・commitの参照は`requestId`によらず保存済みを返す |

受入成果物（受入証跡）はWorkが所有する。Managerは`accept_task`の任意の`deliverables`（`repositoryId`・完全な`commitSha`・変更した`paths`・`pullRequestUrl`）で、受け入れた変更の参照をTASK_ACCEPTEDのChangeに残す。RepositoryはTaskのProjectに登録されたものだけで、`pullRequestUrl`はhttp(s)のRepositoryでは`{Repository URL}/pull/{番号}`だけ、URLがhttp(s)でないRepository（ローカルの検証用Repository等）では`null`だけを受け付ける（違えば`VALIDATION_ERROR`）。Serverは外部のGit・GitHubへ問い合わせず、Reviewer・Managerが確かめた成果物と、相談へ登録する参照の一致を検査する。成果物なしで受け入れたTask（Web UIの運用者による受入を含む）からは反映済みにできない。

path・commit SHA・PR URLの形式検査はDirectionのADR参照（`record_adr_reference`）と同じ`@compass/shared`の部品を使う。Repositoryの本文は正本のまま複製しない。既存のDirection ADR経路（Intentの`adr_candidate` Decision起点）は変えず、相談由来の結論からIntent・Direction Decisionを作らない。

反映状況は相談の`resolved`と別に、文書反映Taskの状態と成果物参照から読むたびに求める。

| 反映状況 | 条件 |
| --- | --- |
| `pending`（反映待ち） | 文書反映Taskが`todo` |
| `in_progress`（対応中） | 作業・レビュー・受入待ち・差戻し、または受入済みで成果物参照の登録待ち |
| `reflected`（反映済み） | 受入済み（`accepted`）のTaskの成果物参照がある |
| `canceled`（取消） | 文書反映Taskの取消 |

Task待機はProject相談だけのため、元Taskの再開条件はProject相談の依頼だけが持つ。結論が成立すれば、元Task（相談を待つTask）は文書反映を待たずに再開できる。依頼に`resumptionDependency`（文書を先に確定する理由）を指定した場合だけ、その依頼が`pending` / `in_progress`の間は`ConsultationReadinessPort`が`prerequisiteTaskIds`を返し、`list_consultation_resumptions`は`waiting`と理由を返し、`resume_consultation_task`は`TASK_NOT_CLAIMABLE`で拒否する。反映済み・取消になれば待機条件から外れる。文書反映Taskは新しく起票され、元Taskの受入を待つ条件を持たないため循環しない。

Activityは反映担当ProjectのActivityとして、依頼（`consultation.followup_requested`）と反映（`consultation.followup_reflected`）をcanonicalに1件ずつ記録し、要約と参照（相談。Workspace相談は`workspace_consultation`でWorkspaceの相談詳細へ辿る・Task・Repositoryのpath/commit・PR URL）だけを持つ。会話全文・文書本文は複製しない。文書反映Taskの起票・受入はWorkの通常のcanonical Activityとして残る。

回帰テストは`node --import tsx --test server/tests/consultationFollowup.test.ts`（実際にcommitした検証用git Repositoryを使い、公開MCP・Web APIで依頼→Worker→Reviewer→受入成果物付きのManager受入→参照登録→詳細・Activity・再起動後の保持と、受入証跡に無いpath・commit・PRの拒否、Workspace相談の結論から所属Projectへの引継ぎと所属しないProject・権限不足の拒否を確認する）。
