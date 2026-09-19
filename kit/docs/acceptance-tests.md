# Acceptance Tests

## 共通fixture

Project「協調開発」、Mission「Agentが安全に協働できる基盤を提供する」、Intent「複数Agentが重複実行せず仕事を進められる状態を作る」。completionDefinitionは対象環境で二重Claimがなく、中断したClaimを復旧できる証拠が揃うこと。

Outcome A「二重Claimをなくす」、Criterion C1: duplicate_claim_count eq 0、C2: abandoned_claim_recovery_ratio gte 1.0。観測はstaging、revision r1、明示した1時間、各100件以上。Evidence E1は重複3件、E2は復旧率1.0。これは説明用fixtureであり、実Wachaの機能を前提としない。

## 受け入れシナリオ

| ID | Given / When | Then |
|---|---|---|
| A01 | 空DBでProject登録・設定保存、再読み込み | Mission等と複数Repository / Resourceを保持。Activityに作成記録 |
| A02 | 同じProjectで2つのIntentを同時活性化 | 1件のみactive。もう一方は409 |
| A03 | CriterionなしOutcomeを活性化 | 422。ExecutionRequest / outboxを作らない |
| A04 | Outcome活性化後に成功条件を編集 | 拒否。snapshotが不変 |
| A05 | Request送信後に応答が消失し同じIDで再送 | Wacha Outcomeが1件、ExecutionLinkが1件 |
| A06 | Wachaがcompletedを通知 | Execution Summaryは完了。compass Outcomeは自動achievedにならない |
| A07 | E1=3件、E2=1.0でEvaluatorが評価 | C1 fail / C2 pass、not_achieved。根拠が辿れる |
| A08 | C1 pass、C2は証拠なしまたは観測条件不一致 | insufficient_evidence、evaluatingのまま。追加観測要求を保存 |
| A09 | A08後に有効な追加Evidenceが届く | 新Evaluationを追加してachieved。旧評価を保存 |
| A10 | 未達Evaluationを根拠に次方向を決定 | 同じIntent内にOutcome B、priorOutcomeId=A、Decisionで接続 |
| A11 | A10のCommandを再送または並列実行 | 次方向DecisionとOutcome Bは1組のみ |
| A12 | 最新sequenceの後に古い・重複イベント到着 | 実行状態が逆戻りせず、二重評価要求なし |
| A13 | DB保存後・配送前にプロセス停止、再開 | 未配送outboxを取得でき、業務状態が失われない |
| A14 | Wacha未接続・切断・古い集計 | Homeは閲覧でき、未接続 / 取得不能 / 最終取得時刻を表示。0件と偽らない |
| A15 | 別ProjectのEvidence / Outcome / Requestを参照 | 拒否。データ混入と他Project情報の露出なし |
| A16 | Worker roleまたはStrategist自身のRunで成果評価 | 403または独立性違反。Evaluationを確定しない |
| A17 | Project停止とOutcome活性化を競合させる | 停止確定後の新規dispatchなし。送信済みは停止確認待ち |
| A18 | cancelled Outcomeへ遅延completed通知 | 監査保存だけ。Outcomeを復活させない |
| A19 | 観測要求・Outcome周回が予算に到達 | 次要求を拒否、理由を記録しpaused。成功扱いなし |
| A20 | Outcome成功だがIntent全体の証拠不足 | Intentはactiveのまま。根拠なしcomplete_intentを拒否 |
| A21 | 全体完了根拠と未解決実行なしでcomplete_intent | Intent achieved、Decisionと根拠を保持、新しいOutcomeは自動作成しない |
| A22 | Research / EvaluationからHomeを描画 | Learningの出典へ遷移可能。架空の知見や活動なし |
| A23 | 同一冪等キーで異なるpayload、古いversionで更新 | 409、部分更新なし |
| A24 | Wachaの旧Storyと新Outcome所属Storyが共存 | 旧機能が動作し、新OutcomeからStory / Taskへ辿れる |

## 単体利用の検証

[単体利用仕様](standalone-and-integration.md)のS01〜S07を追加する。compass側は相手サービスとfakeなしで正式フォームから往復を実施し、Wacha側は外部IDのないlocal Outcomeで既存Work機構が動くことを確認する。連携モードのA03はExecutionRequestが生成されないことを確認し、単体モードでも不正な活性化から通常ドメインイベントが生成されないことを確認する。

## ローカルMVPのデモ

seedでProjectを用意し、HumanのIntent投入、別Roleのfixture Command、fake Wacha受領、未達評価、次Outcome作成、成功評価まで再現する。デモは実行ごとにIDを分離し、ネットワークに依存しない。固定値によるデモであることをUIとREADMEに明示する。

P4ではA01〜A23をcompass側で検証し、A05 / A12 / A18はfake契約で検証する。A24はWacha側で担当する。P5では境界シナリオを実接続でも再実行する。

## Lv6受け入れ（P6）

実Wachaと外部Runtimeを使う隔離された検証環境で、HumanのIntent投入以降に手動Command・承認・Run再起動なしで、Research → Outcome A → Execution → 未達Evaluation → Decision → Outcome B → Execution → 成果評価の2周を行う。追加で証拠不足から再観測するケース、通信断または再起動から復旧するケースを行う。

記録するもの：実行ID、環境、接続版、全correlationId、Outcomeと評価のリンク、経過時間、介入回数、予算消費、停止理由。介入回数0と証拠の連鎖を確認する。未接続・人による修復・固定回答の投入がある場合は未達とする。compass単体の完了とシステム全体のLv6達成を別々に報告する。
