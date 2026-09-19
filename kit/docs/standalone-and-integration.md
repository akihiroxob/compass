# 単体利用と連携利用

## 製品としての方針

compassとWachaはそれぞれ独立して導入・起動・保存・操作できる。相手のDB、資格情報、API到達性を起動条件にしない。単体利用は正式な利用形態であり、fake連携や劣化したデモとして扱わない。

| 利用形態 | 入力 | できること | 別途必要なもの |
|---|---|---|---|
| compass単体 | Project、Intent、調査・実行結果・観測証拠 | Outcome設定、調査、評価、次方向決定、現場把握 | 実作業は人・外部ツール等で実施。自律運転には外部Runtime |
| Wacha単体 | Wacha内で作成したOutcome、または既存Story / Task | 作業分解、Claim、Review、Acceptance、実行状況管理 | 実作業を担う人またはAgent。自律運転には外部Runtime |
| compass + Wacha | compassのIntentとOutcome | 方向から実行、証拠と評価への接続 | 無人で継続するなら外部Runtime |

相互独立性と自律性は別軸。相手がなくても利用できることは、Agentを内蔵することではない。手動利用を許すが、手動操作をLv6達成と数えない。

## compass単体

ProjectのexecutionModeはstandalone / wacha。初期値standalone。fakeは製品モードではなく、wacha連携をテストする開発用adapterとする。

standaloneではOutcome活性化時にDecision、固定snapshot、OutcomeActivatedイベントを保存し、Wacha宛ExecutionRequestは作らない。Wachaの未接続を障害として出さず、Execution Summaryに「外部実行・手動登録」と登録内容の時刻を表示する。

外部実行記録ExternalExecutionRecordを補助レコードとして追加する。id、projectId、outcomeId、summary、status（reported_running / reported_completed / reported_failed）、sourceRef?、evidenceIds、observedAt、actorを持つ。不変の追記形式とし、訂正はsupersedesRecordIdで関連づける。TaskやClaimの正本にはしない。記録がなくても独立した観測Evidenceから評価できる。

Project内で認可された人または外部サービスが、Research / Evidence / 外部実行記録を登録し、Strategist / Evaluatorの役割に応じてOutcomeとEvaluationを操作できる。手動用の最小フォームと同じCommand APIを提供し、開発scriptがないと使えない設計にしない。

Humanが使う場合も認証された役割と監査情報を持つ。Runを持たない人の独立性はprincipalIdで検証する。成果物の作成者と評価者を同一主体にしない。自分で成果物を作った場合は別の評価者が必要。外部の実行主体が不明なら独立性未確認と記録し、検証済み自律運転と表現しない。単体利用は単一主体による自己承認を意味しない。

## Wacha単体

Wacha Outcomeにorigin=local / externalを持たせる。

- local: Wacha内の人または認可されたManagerが作成する。目的、期待する状態、成功条件、制約をWachaが保持する。compassのProject / Intent IDは不要。
- external: compassから受領する。Direction情報はcompassの固定snapshotであり、Wachaから変更しない。

両者に同じStory / Task / Claim / Review / Acceptanceの機構を使う。executionStatusと成果評価を分ける原則は共通。localで成功条件を記録しても、WachaにResearch→Evaluation→次OutcomeのDirection Loop全体を作る必要はない。

localの初期編集はqueuedかつ実行開始前のみ。running以降は目的・成功条件を固定し、変更時は新Outcomeに分ける。作成・編集・開始のCommandを既存認証・権限・冪等性に組み込む。

## モードの変更と後からの連携

compassのexecutionModeはProject Contextの版に含め、Outcome活性化時に固定する。進行中Outcomeまたは未解決ExecutionRequestがある場合の変更は409。standaloneの履歴を後からWachaへ自動送信しない。次Outcomeから連携を開始する。

Wachaのoriginは作成後変更不可。local Outcomeをexternalに自動変換しない。後から関連づける場合は参照関係を記録する別機能とし、正本移管や双方向同期は初期範囲外。既存のTask / Storyを別Outcomeへ暗黙に移さない。

wachaモード中の接続断をstandaloneへ自動切替しない。二重実行を避けるため、最後の状態と未解決requestを保持する。

## 受け入れ条件

- S01: Wachaの設定なしでcompassを起動し、Project作成→Intent→Outcome→外部証拠→評価→次Outcomeを、正式UI / APIで完了できる。
- S02: S01中にWachaへの通信、Wacha宛outbox、接続障害アラートを発生させない。通常のドメインイベントは保存する。
- S03: compassの設定なしでWachaを起動し、local Outcome→複数Story / Task→Review / Acceptance→実行完了を扱える。
- S04: Wacha localの外部IDはnullでよく、externalには必要な参照を必須とする。externalの条件編集を拒否する。
- S05: 単体利用の保存・再起動・権限・不変条件テストが通る。相手のサービスを立ち上げる必要がない。
- S06: 終了済みの単体履歴を保ったまま、新Outcomeから連携できる。進行中のモード変更を拒否する。
- S07: standalone / 実連携 / デモを画面で区別し、接続断時に自動でモードが変わらない。

compass側S01 / S02 / S05〜S07はP4まで、Wacha側S03〜S05はWacha単体実装の完了条件とする。実連携の試験はP5で別に行う。
