# Wacha向け実装指示書：Outcome対応

このファイルはWachaリポジトリを担当するCodexへ単独で渡せる。compass実装の一部としてWachaを作り直す指示ではない。実装前にWachaのAGENTS.md、現行モデル、API、認証、migration、テストを読み、既存設計を優先する。compass側の提案契約は[wacha-boundary.md](wacha-boundary.md)。

## 目的

WachaにOutcomeの概念を追加し、「何の成果のためのStory / Taskか」を辿れるようにする。Outcomeの実行状況を集約し、compassへ実行結果とEvidence参照を返す。

compassはDirection Loopの正本で、Outcomeの目的・成功条件・成果評価を管理する。WachaはExecution Loopを所有し、受領したOutcomeをStory / Taskへ分解して実行する。Runtime / Orchestratorは別システムである。

## 単体利用を正式に支援する

compassなしでもWachaを起動・操作でき、Wacha UI / APIでlocal Outcomeを作成できること。外部Runtimeは自律実行時に接続するもので、通常のデータ管理の起動条件にはしない。[単体利用仕様](standalone-and-integration.md)も参照する。

## WachaのOutcome

現行Wachaに同名概念があれば重複モデルを作らず意味を調査し、差分を記録して拡張する。新規の場合は以下を持つ。

| フィールド | 意味 |
|---|---|
| id | Wacha内の安定ID |
| projectId | Wacha側Project。compassとの対応表で検証 |
| origin | local / external。作成後変更禁止 |
| sourceSystem | externalではcompass。localではnull |
| sourceProjectId / sourceIntentId / sourceOutcomeId | externalでは必須。localではnull |
| sourceVersion / contextVersion | externalの固定版。localはローカルversionで競合管理 |
| requestId / payloadHash | externalの冪等受領に使用。localではnull、作成Command自体は冪等キーを使用 |
| title / desiredState / hypothesis | externalは受領snapshot、localはWachaで入力 |
| successCriteriaSnapshot / constraintsSnapshot / prioritySnapshot | externalは読み取り専用。localは実行開始前のみ編集可 |
| executionStatus | queued / running / completed / failed / cancelled |
| executionSummary / evidenceRefs | 実行状況と結果の根拠 |
| sourceUrl / createdAt / updatedAt | compassへのリンクと監査情報 |

WachaのOutcomeにachieved / not_achievedという成果判定を持ち込まない。compassの評価を参考表示するならdirectionVerdictという読み取り専用投影としてexecutionStatusと分け、取得時刻を付ける。

externalだけに適用する部分一意制約で(sourceSystem,sourceOutcomeId,sourceVersion)とrequestIdを一意にする。localには外部IDを要求しない。sourceSystemだけでは複数compass接続を識別できない場合は接続IDを一意キーに含める。

## Story / Taskとの関係

Outcome 1:N Story、Story 1:N Task。StoryにnullableなoutcomeIdを追加する。初期版では1つのStoryを複数Outcomeで共有しない。TaskはStory経由でOutcomeを辿る。現行モデルにStoryなしTaskがある場合は、その既存仕様を壊さず、Outcome内に含めるには明示的な所属経路を追加してテストする。

同じProject内でのみ紐付ける。Outcomeに属するStoryの目的を変えてもcompassの成功条件は変更できない。既存のStory Acceptance CriteriaとOutcome SuccessCriterionは別概念として維持する。

local OutcomeはWacha UI / APIから認可された人またはManagerが作成する。外部のIntentは不要。目的・成功条件はqueuedかつ実行開始前のみ編集でき、開始後は固定する。externalは受領時から固定する。既存の未所属Story / Taskも利用を続けられる。compassのResearch / Evaluation / 自動再戦略化までは複製しない。

## 受領と状態

ExecutionRequestを認証・schema・Project対応・固定版について検証し、Outcomeと受領記録を同一トランザクションで保存する。受領時にAgentを直接起動しない。既存のイベント機構またはRuntime向けイベントを発行する。

同じrequestId・同じpayloadは同じwachaOutcomeIdを返す。異なるpayloadは409。送信元のOutcomeが終端化してから同じIDを別内容で使い回すことは許さない。

queued → running → completed / failed / cancelled。queuedからfailed / cancelledも可。completedの条件は、Managerが計画分解を完了したことを示し、対象Storyが1件以上存在し、対象のすべてが既存Acceptance規則を満たし、実行結果の集約が保存済みであること。空集合をcompletedとしない。対象Storyを途中で追加する場合は完了判定と同じ競合制御下で行う。

failedは個別Taskの一時失敗ではなく、既存の復旧・再計画方針を使い切った実行の終端。completedは「要求された実行を終えた」であって「目的を達成した」ではない。初期版では終端Outcomeをreopenしない。追加実行はexternalではcompassの新Outcomeとして受け、localではWachaで新Outcomeを作成する。

取消要求は冪等に受領し、可能な範囲で新規Task取得を止め、実行中作業を既存の停止方針で扱う。安全な停止が確認できるまでcancelledを返さない。既に終端ならその状態を返す。compassに停止済みと偽って返さない。

## 公開する機能

HTTPルート名は現行Wachaの命名に合わせてよい。必須能力は以下。

1. local Outcomeの作成・開始前編集・開始・照会（例: POST /outcomes、PATCH /outcomes/:id、POST /outcomes/:id/start）。既存のrole権限と冪等性を適用。
2. externalのExecutionRequestの冪等受領とrequestIdによる照会。
3. Outcome詳細と紐づくStory / Taskの読取。
4. 取消要求の受領と状態照会。
5. Projectごとの実行集計と観測時刻。
6. 単調増加sequence付きExecutionResultイベントとEvidence参照の配送。

compass宛の結果配送はexternalだけに行う。localは通常のWacha業務イベントを保存し、架空のrequestIdやcompass宛通知を作らない。

外部契約はschemaVersion=1、requestId / outcomeId / outcomeVersion / wachaOutcomeId / eventId / sequence / correlationIdを持つ。機械可読スキーマとfixtureを両リポジトリで照合する。compassのDBを直接更新しない。

Wachaの業務更新と結果outboxは同一トランザクション。配送はat-least-once。失敗した通知を再送しても結果イベントを別の業務実行として扱わない。実行完了通知が成果測定に十分な証拠を含まない場合も、その不足を明示して通知できる。

## 既存データの移行順序

1. 既存Outcome相当・Story / Task関係・Project識別・認証・イベント機構を調査し、差分一覧を作る。
2. Outcome表と任意参照を追加するadditive migrationを作る。既存のstatus enumを置き換えない。
3. 既存StoryのoutcomeIdはnullのまま維持する。説明文から架空のOutcomeを自動生成しない。
4. 受領・照会・結果通知と契約テストを実装する。
5. local Outcomeの作成・編集・開始APIとフォームを追加し、compass未設定で試験する。Outcomeを指定する新規Story作成を追加する。既存作成APIは引き続き動く。
6. Outcome詳細、Storyの所属表示、Project実行集計を追加する。
7. 新旧両経路で回帰試験し、実compassと往復試験する。

ロールバックはまず連携機能を無効化する。追加表や履歴を即削除しない。既存データの書き換えや制約強制は別の移行として扱う。

## 受け入れ条件

- 同じ要求を並列で2回送ってもOutcomeは1件、Storyの自動二重生成なし。
- 異なるProject参照と同一requestIdの内容差分を拒否する。
- Outcomeから複数Story / Taskへ辿れ、既存の未所属Storyも従来通り利用できる。
- externalの受領snapshotはWachaから変更できない。localは実行前のみ編集できる。
- compassの設定・接続なしでlocal Outcomeから実行完了まで操作できる。外部IDは不要。
- 複数local Outcomeを作成でき、外部IDの一意制約に妨げられない。
- 個別Task完了・Review承認だけではOutcomeをcompletedにしない。
- completed通知後もcompassの成果判定はEvaluator待ちである。
- 通知配送中断・再起動後に再送できる。
- 取消要求・遅延結果・通知順序逆転を両側で扱える。
- 既存のClaim / Review / Acceptanceテストが通る。

## 対象外

compassのMission / Intent / Research / Evaluationの正本移管、Runtime自作、既存Task状態の全面改修、既存データの強制Outcome化、成果評価の自己承認は行わない。

## Wacha担当Codexへの開始指示

「この指示書を読み、Wachaの既存設計を調査し、Outcome対応をadditiveに実装してください。まず差分と移行方針を短く示し、local Outcomeの単体操作→外部受領→Story紐付け→結果通知→UI→回帰試験の順で進めてください。compassの実接続情報がなければ契約fixtureで検証し、接続済みと報告しないでください。」
