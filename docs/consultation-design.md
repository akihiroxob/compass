# Project相談（Collaboration）

Agentが既存の要件・方針・権限の範囲で決められない設計・要件の問題を、Project scopeの相談としてHumanへ問い、会話と結論をCompassへ残す。所有Contextは`packages/collaboration`（[ADR 0002](adr/0002-collaboration-context.md)）。Task単位の相談待ち・自動再開、Workspace scopeの相談、横断一覧、文書反映Taskは含まない（[実装計画](planning/consultation-implementation-plan.md)の後続増分）。

## 保存するもの

| 記録 | 内容 |
| --- | --- |
| Consultation | 所属Workspace・Project、タイトル、判断したいこと（`question`）、進めない理由（`blockingReason`）、選択肢（`options`。`label`・任意の`description`）、推奨（`recommendation`）、影響（`impact`）、参照（`refs`）、状態、版（`revision`）、方針変更元（`supersedesConsultationId`）、起票者、取消の理由・主体・日時 |
| Message | 相談内の順序（`sequence`）、記録主体（`author`）、本文、訂正元（`correctsMessageId`）、発言で進んだ版。追記だけで書き換えない |
| Resolution | 相談につき1件。結論・判断の根拠・適用範囲・採用した選択肢（`selectedOption`）・根拠の発言（`basisMessageIds`）と版（`basisRevision`）・判断の由来（`source`）・記録主体 |
| 応答lease | 相談ID・入力版・保持Principal・期限（5分）・解放日時。TaskのClaimとは別 |
| 受付記録 | 主体・操作・`requestId`ごとの入力hashと結果 |

記録主体（`author`・`recordedBy`・`createdBy`・`cancellation.by`）は`kind`（`human` / `agent`）・`principalId`・`role`で、入力からは受け取らない。Humanは`human:{humanUserId}`・`operator`、AgentはBearerのPrincipalと認可したExecution Role。

参照は`{kind:'url', url}`・`{kind:'project_resource', resourceId, path?, revision?}`・`{kind:'task'|'story'|'consultation', id}`で、Project Resource・Task・Story・相談は同じProjectのものだけを受け付ける。Repository / Docsの本文は複製しない。

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
3. `reply_consultation`（回答・追加質問）または`resolve_consultation`（managerだけ）へ`leaseId`と`expectedRevision`を渡す。応答中にHumanが追加で返信すると版が進み、古い版の応答・解決は`STALE_REVISION`で拒否される。期限切れは`LEASE_EXPIRED`、leaseを持たない・使用済みは`LEASE_NOT_HELD`。応答を保存するとleaseを解放する。
4. `requestId`は主体・操作ごとに一意にする。同じ`requestId`・同じ入力の再送は、その後に状態が変わっていても保存済みの結果を返し、別の入力での再利用は`IDEMPOTENCY_CONFLICT`。

拒否はいずれも`CONFLICT`で、`conflict`・`consultationId`・`currentRevision`・`consultationStatus`を返す。自動dispatch（Orchestratorの起動）はまだ無く、検証者・AgentはMCPを直接操作して応答できる。

## 結論と判断の由来

| 由来 | 入口 | 記録主体 | 条件 |
| --- | --- | --- | --- |
| `human_decision` | Web API `POST .../resolution`（administrator以上） | Human | 表示した版（`expectedRevision`）が現在の版。`waiting_human` / `waiting_agent`のどちらでも記録でき、根拠の発言は任意 |
| `agent_summary` | MCP `resolve_consultation`（manager） | Agent | 応答leaseと現在の版。`basisMessageIds`にHumanの発言を1つ以上含む |

由来は入口と記録主体から決め、入力では指定させない（MCPで`source`等の未知の項目は`VALIDATION_ERROR`）。DBも由来と記録主体の組を制約する。Humanの明確な返信を根拠にManagerが結論を保存でき、再承認は求めない。通常の許可・既存方針内の判断を相談にする手順は設けない。

## 認可

| 操作 | Human（Project Membership） | Agent（Project Execution Role Grant） |
| --- | --- | --- |
| 一覧・詳細 | viewer以上（`project.read`） | manager / worker / reviewer |
| 作成 | なし | manager / worker / reviewer |
| 返信 | editor以上（`consultation.reply`） | manager / worker / reviewer（応答lease） |
| 結論 | administrator以上の明示決定（`consultation.decide`） | managerの結論整理（応答lease） |
| 取消 | administrator以上（`consultation.decide`） | manager |

Humanは未所属・存在しないProject・別Projectの相談IDを404で区別しない。AgentはGrantが無ければ`FORBIDDEN`、別Projectの相談IDは`NOT_FOUND`。Workspace Direction Role・旧Project Direction Grantでは参照・記録できない。AgentはactiveRole（`X-Compass-Active-Role`）または`role`入力でRoleを決め、どちらも無い記録は`VALIDATION_ERROR`。archivedのProjectは参照だけでき、記録は`CONFLICT`（`projectStatus: archived`）。

## 公開入口

Web API（Human。Session・CSRF）:

| method・path | 内容 |
| --- | --- |
| `GET /api/projects/:projectId/consultations?status=` | 一覧（更新の新しい順。`status`省略で全件） |
| `GET /api/projects/:projectId/consultations/:consultationId` | `consultation`・`messages`・`resolution`・`responder`（有効な応答leaseの保持者・期限） |
| `POST .../messages` | 返信`{ body, correctsMessageId?, requestId }`（201） |
| `POST .../resolution` | 明示決定`{ conclusion, rationale, applicability?, selectedOption?, basisMessageIds?, expectedRevision, requestId }`（201） |
| `POST .../cancel` | 取消`{ reason, expectedRevision, requestId }` |

MCP（Agent）: `create_consultation`・`list_consultations`・`get_consultation`・`acquire_consultation_lease`・`reply_consultation`・`resolve_consultation`・`cancel_consultation`。Humanの明示決定のtoolは無い。

Web UI: Project詳細の「判断待ち」view（`?view=consultations`。`?status=`で絞り込み、既定はHumanの判断待ち）と相談詳細（`/projects/:projectId/consultations/:consultationId`）。詳細は上段に質問・選択肢・推奨・影響・参照、下段に会話（Humanの発言とAgentの発言を帯の色と文言で区別）と返信、結論または取消の理由を出し、開いている間は15秒ごとに読み直す。導線はRoleとProjectの状態で出し分け、拒否はserverが行う。

## 専用環境での公開操作による確認

既存DBを使わず、新しい専用ディレクトリの`COMPASS_DB_PATH`、loopbackの`COMPASS_PUBLIC_ORIGIN`と`PORT`、`COMPASS_AUTH_MODE=trusted-local`、`COMPASS_INITIAL_OWNER_EMAIL`を設定してbuild後のserverを起動する。開発用WachaのMCPとは接続先を分ける。

1. 初期ownerが開発用ログインし、Web UIまたはSession・CSRF付きWeb APIでWorkspace（`POST /api/workspaces`）、Project（`POST /api/workspaces/:workspaceId/projects`）を作成する。
2. ownerがProjectの招待（`POST /api/projects/:projectId/invitations`）をadministrator・editor・viewerへ発行し、それぞれ別ブラウザContextで招待リンクからログイン・受諾する。未所属Humanは別Projectの招待で用意する。Workspace MembershipはProjectから継承しない。
3. ownerがProjectのGrant（`POST /api/projects/:projectId/grants`）を別Principalのworker・reviewer・managerへ付与する。専用originの`/mcp`でBearer Principalと`X-Compass-Active-Role`を指定する。
4. workerが`create_consultation`で質問・選択肢・推奨・影響を登録する。HumanがProjectの「判断待ち」から詳細を開き、editorが通常返信する。managerが詳細を読み、現在の版のleaseを取得し、HumanのMessageを根拠に`resolve_consultation`で結論を整理する。
5. 再読込・同schemaでのserver再起動後に会話と結論が保持され、`agent_summary`とHumanの発言が区別されることを確認する。Humanの明示決定はadministratorのWeb UIから別相談で確認する。
6. viewerの書込拒否、未所属・別Projectの404、古い版・他Principalのlease・期限切れの拒否、同じ`requestId`の再送を確認する。Desktopと狭い画面の画像を保存し、空・読込・通信失敗・権限不足を確認する。読込遅延や通信失敗の模擬は表示検査だけに用い、保存・認可の成功の証拠にはしない。

回帰テストは`node --import tsx --test packages/collaboration/tests/consultation.test.ts server/tests/consultation.test.ts server/tests/consultationUi.test.ts`、UI構造検査は`npm run check:ui`。テスト内の時刻差し替えでlease境界を検査することと、実環境で期限を待つ確認は区別する。専用serverは確認後に停止する。
