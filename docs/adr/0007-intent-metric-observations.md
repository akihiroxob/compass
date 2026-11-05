# ADR 0007: Intentの観測値を版付きの時系列としてDirectionに保持する

- 状態: 承認
- 対象: Direction / Server（MCP・Web API）/ Role

## 決定

Intent（ビジネス目標）の到達点・推移は、Directionが所有する観測項目（`intent_metric`）と対象期間ごとの観測値（`intent_metric_observation`）で表す。観測項目は単位・任意の目標値・鮮度の期限を明示的に持ち、目標値・比率をIntentの説明文から生成しない。Outcomeの成功条件・Evaluation・Execution Evidenceとは別の記録とし、新しい必須階層や独立したSuccess Metrics管理UIを追加しない。

観測値は対象期間（暦日）ごとの版を追記する。既存のいずれかの版と同じ内容（観測時刻を含む）の再送は新しい版を作らず、訂正は次の版になる。取得失敗は値なしの観測として残し、観測の無い期間は保存・応答しない。読み取りは`unmeasured`・`failed`・`stale`・`observed`を区別し、ゼロや推測値で時系列を埋めない。

定義はStrategist、記録はEvaluatorのWorkspace Grantで認可する。目標値は目標の意味に属するためStrategistが持ち、観測はEvaluatorの観測の責務に合わせる。参照はWorkspaceの参照者とHumanのWorkspace Membershipに公開する。外部分析サービスとの接続・計測基盤は前提にしない。

## 理由

既存のExecution EvidenceはProjectの成果物参照、Research Evidenceは調査の根拠で、どちらもIntentの数値の時系列（単位・期間・値・取得失敗）を表せない。Outcomeの成功条件は作成時に固定され、Intent全体の推移と目的が異なる。再送・訂正を版で表すと、記録元のrequest keyを要求せずに重複を防ぎ、過去の値を保持できる。観測値は高頻度の運用データのため、意味のある履歴としてのActivityへ投影しない。

## 保存と検証

新規DBのschemaに2 tableを追加し、旧DBへの移行は行わない。観測項目はIntentと同じWorkspaceへ複合FKで固定し、観測値の値・状態の組合せと版の一意性をDB制約でも守る。`server/tests/intentMetric.test.ts`が公開入口（MCP・Web API）で再送・訂正・再起動後の永続化、別Workspace・Role・不正な値／期間／時刻・非activeなIntent・archived Workspaceの拒否、未計測・古い観測・取得失敗・ゼロの区別を確認する。
