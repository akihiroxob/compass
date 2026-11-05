# Intentの現行仕様

IntentはHumanが現在実現したい状態。Workspaceの継続的な存在理由であるMissionと区別する。型は [Intent.ts](../packages/direction/src/domain/Intent.ts)、入力規則は [intentSchema.ts](../packages/direction/src/application/intentSchema.ts)。

## 項目と状態

`workspaceId`、`status`、`abandonedReason`、ID・作成更新日時と、Humanが入力する次の項目を持つ。入力規則はWeb UIとMCPで共通（`intentSchema`）。

| 項目 | 画面の表示名 | 必須 | 規則 |
| --- | --- | --- | --- |
| `title` | 目標名 | 必須 | 前後空白を除き1〜100文字 |
| `desiredState` | 実現したい状態 | 必須 | 前後空白を除き1〜2,000文字 |
| `background` | 背景 | 任意 | 2,000文字まで |
| `audience` | 対象 | 任意 | 2,000文字まで（誰・何に向けた目標か） |
| `constraints` | 制約 | 任意 | 2,000文字まで |
| `completionDefinition` | 達成条件 | 任意 | 2,000文字まで |
| `targetDate` | 目標日 | 任意 | 実在する暦日の`YYYY-MM-DD` |

任意項目は未指定・`null`・空文字を未設定（`null`）として保存する。

状態は`active` / `achieved` / `abandoned`。Workspace内に複数のActive Intentを保持でき、追加作成で既存のIntentを暗黙に放棄しない。作成時はactive。Humanの放棄はabandonedへ遷移する。Strategistの根拠付き`intent_complete`判断でachievedへ遷移する。終端からの復帰操作はない。

## 更新と操作

activeの間だけ部分更新できる。未指定の項目は変更せず、任意項目は`null`または空文字でクリアする。Outcomeを持つIntentはdesiredState / completionDefinitionを変更できない（title・背景・対象・制約・目標日は変更できる）。archived Workspaceでは書込を拒否する（WorkspaceのarchiveはWorkspace ownerが行い、Projectのarchiveでは変わらない）。

`intent_complete`も、Intentを更新するtransaction内で所属Workspaceのarchiveを検査する。WorkspaceだけarchivedでProjectがactiveでも`CONFLICT`（`workspaceStatus: archived`）を返し、Intent・Decision・Activityを変更しない。

保存・application use case・公開入口はWorkspace単位。Project IDをWorkspace IDとして受け付けない。応答は`workspaceId`を持ち、`projectId`は持たない。

HumanはWorkspaceの「Outcome」（方向）画面で、ページ上部の「目標を作成」と各目標カードの「編集」から入力する（概要の要対応、Project詳細・Intent詳細の導線も同じフォームを使う）。フォームは「目標名・実現したい状態」「背景・対象・制約」「達成の確認（達成条件・目標日）」に分け、保存はIntentの登録・更新だけでAgentを起動しない。UIに目標相談のAIチャット・開始ボタンは置かない。Web APIは`/api/workspaces/:workspaceId/intents`とその詳細・更新・`abandon`。参照にはWorkspaceのviewer以上、変更にはeditor以上のWorkspace Membershipが必要で、操作者は認証済みHuman（`human:{humanUserId}`）として記録する。

MCPの`create_intent` / `update_intent`は、外部MCPクライアントでHumanと整理した目標をAgentが登録する正規の入口で、trusted-local・remoteの両modeで公開する。対象WorkspaceのStrategist Grant（`X-Compass-Active-Role`指定時は`strategist`）を要求し、Worker・Reviewer等のProject Role、別WorkspaceのGrant、Grantの無いPrincipalは`FORBIDDEN`。操作者はStrategist（Agent）として記録し、Humanの操作として扱わない。trusted-localのBearer・activeRoleなしの保守呼出しだけはGrantを問わず、操作者は`system`になる。`abandon_intent`はHuman管理操作としてtrusted-localだけに登録し、WorkspaceのDirection Role Grantを持つPrincipalとactiveRole指定を拒否する。remote modeのMCPには`abandon_intent`等のHuman管理toolを公開しない。

保存は新規DBのschemaで定義する。項目を追加したschemaは旧DBへ列を補わないため、開発DBは再作成する。

## Researchとの接続

Intent作成はResearch Requestを作らない。OrchestratorがActive IntentでStrategistを起動し、StrategistがResearchの必要性を判断する（必要なら`additional_research`のDirection Decisionで依頼する）。起動条件は [Orchestrator](../orchestrator/README.md)。

## 複数目標と起動対象

`get_workspace_orchestration_state`は`activeIntents`を新しい順に返し、全Active IntentのOutcomeを`intentId`付きで返す。Intent配下のResearch・最新Evaluation・判断はそれぞれのIntentで読む。Orchestratorは各Intentの進行中Outcome・Research・判断待ちEvaluationを個別に判定し、別目標の完了・待機で対象目標を止めない。Researchを一律必須にしない。

`get_strategist_context({ workspaceId, intentId })`は指定したIntentのOutcome・Research・Evaluation・Targetだけを返す。別WorkspaceのIntentは`NOT_FOUND`。`intentId`省略はActive Intentが0〜1件のときに限り、複数件なら`CONFLICT`として`list_intents`からの明示選択を求める。dispatchの`intentId`・`COMPASS_INTENT_ID`をContext取得に使う。Workspace/ProjectのGrantとCredentialの境界は維持する。
