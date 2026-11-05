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

## 観測項目と時系列

Intentの到達点・推移を確かめるため、Intentごとに観測項目（Metric）と、その対象期間ごとの観測値を保持する。型は [IntentMetric.ts](../packages/direction/src/domain/IntentMetric.ts)、入力規則は [intentMetricSchema.ts](../packages/direction/src/application/intentMetricSchema.ts)。Outcomeの成功条件・評価とは別の記録で、Intent → Outcome → Story／Taskの階層や独立したSuccess Metrics管理UIを追加しない。外部の分析サービスとの接続は前提にせず、取得した値と出所を公開入口から記録する。判断は [ADR 0007](adr/0007-intent-metric-observations.md)。

### 観測項目

| 項目 | 規則 |
| --- | --- |
| `key` | Intent内で一意。英小文字・数字・`_`・`-`・`.`の1〜64文字（先頭は英小文字・数字） |
| `name` | 1〜100文字 |
| `unit` | 1〜30文字（例: `円`・`人`・`%`）。観測値はこの単位で記録する。観測値がある項目の単位は変更できない（`CONFLICT`、`reason: unit_locked`） |
| `targetValue` | 任意の有限数。明示した値だけを保存し、Intentの説明文（`desiredState`等）の数字から生成しない。数値の目標が無ければ`null` |
| `staleAfterDays` | 1〜366の整数。最新の観測の対象期間の終了日（UTCの暦日）からこの日数を超えると古い観測（`stale`） |
| `revision` | 定義の版。同じ定義の再送は変えず（`unchanged`）、名前・単位・目標値・期限の変更で1増える（`updated`） |

### 観測値

| 項目 | 規則 |
| --- | --- |
| `periodStart` / `periodEnd` | 実在する暦日の`YYYY-MM-DD`。両端を含み、366日まで。日次は同じ日 |
| `status` | `observed`（値を取得した）または`failed`（取得を試みて失敗した） |
| `value` | `observed`では必須の有限数（ゼロも有効な値）。`failed`では指定できない（ゼロ・推測値で代替しない） |
| `failureReason` | `failed`では必須（2,000文字まで）、`observed`では指定できない |
| `source` | `name`（必須、200文字まで）と任意の`uri`（http(s)、認証情報を含むURLは拒否）。参照だけで本文を保存しない |
| `observedAt` | 値を取得した時刻（epoch milliseconds）。未来（5分を超える）と、対象期間の開始より前（UTCの暦日で1日の時差を許容）は拒否する |
| `revision` | 対象期間ごとの版。最新版と同じ内容（状態・値・理由・出所・観測時刻）の再送は新しい版を作らず（`unchanged`）、内容が違えば次の版を追記する（`revised`）。過去の版は書き換えない |

1回の記録は1〜100件で、同じ対象期間を重複させない。記録者（Bearerから解決したPrincipal）と記録時刻を保存する。activeなIntentだけに定義・記録でき、achieved / abandonedのIntentとarchivedのWorkspaceは`CONFLICT`。観測値の記録はActivity・Runtime eventを作らず、Outcomeの評価・Intentの完了を意味しない。

### 読み取り

`list_intent_metrics`とWeb APIの`GET /api/workspaces/:workspaceId/intents/:intentId/metrics`は、観測項目（定義順）ごとに次を返す。

- `current.state`: `unmeasured`（観測なし）・`failed`（最新の対象期間が取得失敗）・`stale`（最新の値が古い）・`observed`（期限内の値。ゼロを含む）。`current.latest`は最新の対象期間の最新版（失敗を含む）、`current.lastObserved`は値を取得できた最新の観測。
- `series`: `from`〜`to`（`YYYY-MM-DD`、既定は今日（UTC）までの30日、366日まで）と重なる対象期間の最新版。観測の無い期間は含めず、失敗は`value: null`のまま含む。利用側はゼロ・補間値で埋めない。
- 観測項目が未定義なら`metrics: []`。比率・達成度は計算しない。

### 公開入口と対象Role

| 操作 | MCP | Web API | 認可 |
| --- | --- | --- | --- |
| 観測項目の定義・更新 | `define_intent_metric` | なし | WorkspaceのStrategist Grant |
| 観測値の記録 | `record_intent_metric_observations` | なし | WorkspaceのEvaluator Grant |
| 参照 | `list_intent_metrics` | `GET /api/workspaces/:workspaceId/intents/:intentId/metrics` | MCPはWorkspaceの参照（remote mode・activeRole指定時はWorkspace Role Grant）、Web APIはWorkspace Membership（viewer以上） |

Project Grantからは継承しない。別WorkspaceのIntentは`NOT_FOUND`、別WorkspaceのGrantは`FORBIDDEN`。Human向けの定義・記録の画面は無い。
