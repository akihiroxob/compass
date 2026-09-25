# Wacha Boundary

このファイルは連携モードの契約。単体利用の仕様は[standalone-and-integration.md](standalone-and-integration.md)。Wachaにはlocal / externalのOutcomeがあり、以下のsnapshot制約はexternalに適用する。

## WachaにもOutcomeを追加する

WachaはOutcomeを実行対象として扱い、複数Story / Taskをその下にまとめる。compassのOutcomeを単なる画面リンクに留めない。ただしDirectionの正本を二重化しない。

| 項目 | 正本 |
|---|---|
| Outcomeの目的・仮説・成功条件・優先順位・成果評価 | compass |
| 受領したOutcomeのsnapshot・外部参照 | Wachaの実行用Outcome |
| Outcomeを実現するStory / Task・Acceptance・実行状態 | Wacha |
| Agent Run・起動・再試行 | Runtime |

WachaのOutcomeはローカルIDを持つ実体で、sourceSystem / sourceOutcomeId / sourceVersionと固定snapshotを保持する。これは受領内容を監査する複製であり、Wachaから成功条件を編集するためのコピーではない。具体的なWacha側作業は[Wacha実装指示書](wacha-implementation-instructions.md)に分離する。

## compass側のport

ExecutionGateway: submit(request)、getStatus(requestId)、requestCancellation(requestId, reason)、getProjectSummary(projectId)。接続先の既存API形式はadapterで吸収する。以下は両システム間の提案契約であり、既存Wachaに実在するAPIとはみなさない。

ExecutionRequestは以下を含む。

```text
schemaVersion: 1
requestId: UUID                 # リトライでも固定
projectId / intentId / outcomeId
outcomeVersion                 # active時の固定版
contextVersion
snapshot:
  title / desiredState / hypothesis
  successCriteria[]            # 安定ID、測定・観測・必要証拠を含む
  constraints[] / priority
contextRef                     # 認可付きで参照可能なcompass context
correlationId / requestedAt
```

応答はrequestId、wachaOutcomeId、acceptedAt、executionUrl。compassはExecutionLinkに保存し、Outcomeをactiveのまま保つ。受領は成果達成を意味しない。

ExecutionResult:

```text
schemaVersion: 1
eventId: UUID
requestId / outcomeId / outcomeVersion / wachaOutcomeId
sequence: integer              # request内で単調増加
executionStatus: queued | running | completed | failed | cancelled
summary / evidenceRefs[]
occurredAt / correlationId
```

Evidence参照にはsourceRef、観測時刻、対象環境・revision、metricと値・単位・標本数または成果物情報、取得主体を含める。Wachaの実装完了証拠だけで事業成果を証明できない場合、別の観測元からEvidenceを追加する。

Project SummaryはwachaOutcomeごとの実行状態、相互排他的なTask状態別件数、Story件数、任意のAgent活動集計、observedAt、executionUrlを返す。提供されない数値はnullとし、ゼロで埋めない。

## 耐障害性

- outboxは業務状態と同じトランザクションで記録。配送の再実行に同じrequestIdを使う。
- WachaはrequestIdを一意にし、同じpayloadなら同じOutcomeを返す。違うpayloadの同一IDは409。
- 応答消失時はrequestIdで照合し、別Outcome・Storyを作らない。
- compassのinboxはeventId一意。重複は成功応答して業務状態を再反映しない。
- sequence以下の古いイベントは監査記録だけ残し、実行投影を戻さない。順番が飛んだらgetStatusで照合する。
- 未知request・異なるProject・異なる固定版は隔離し、評価に使わない。
- executionStatus=completedでもOutcomeは自動達成にしない。EvaluationRequestedイベントを発行し、Evaluatorが証拠で判定する。
- failedは成果未達と同義でない。実行障害を記録してResearch / Strategistの判断材料にする。
- cancelled後の遅い結果は監査保存するが、終端Outcomeを復活させない。
- タイムアウト・429・5xxは配送側が上限付きで再試行。認証エラー・スキーマ不一致は無限再試行しない。

停止・取消は要求と確認を区別する。compass Projectをpausedにすると新規dispatchは禁止し、未完了requestに取消要求を記録する。Wachaからのcancelledまたは別の終端応答までは「停止確認待ち」。再開後も旧requestが未解決なら次Outcomeをdispatchしない。ネットワーク分断中の即時停止は保証しない。

## 認証と互換性

送信先・接続情報はサーバー設定に置き、Projectの任意Resource URLを配送先に使わない。サービス資格情報はProjectと許可操作に制限し、受信時に署名または認証tokenを検証する。runRefやpayloadのroleを認証情報の代用にしない。

schemaVersionは必須。不明なメジャー版は拒否。追加の任意フィールドは無視できる。HTTP adapterとfake adapterに同じ契約テストを通す。実Wachaが未対応ならfakeでMVPを完了し、P5を未接続と報告する。
