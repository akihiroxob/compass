# Autonomy / Roles

## Lv6の定義

本プロジェクトでのLv6は、Projectの初期設定・接続・権限・制約を準備した後、Humanが最初のIntentを投入するだけで、調査、Outcome設定、実行、成果測定、評価、次方向決定を継続できる状態。これは本プロジェクトの目標名であり、外部の標準レベルを主張しない。

人向け画面は観察のために必要であり、日常的な承認操作を要求するためではない。任意の停止・設定変更をHumanが行えることと、通常ループにHumanが必須なことを区別する。

## 権限

| 主体 | compassでできること | できないこと |
|---|---|---|
| Human | Project設定、Intent投入、停止・再開・アーカイブ、Intent放棄 | 過去Evidenceや評価の改ざん |
| Researcher | Research / Evidence登録 | Outcome活性化、成果判定 |
| Strategist | Outcome提案・活性化・取消、次方向Decision、根拠付きIntent完了 | Criterionの事後変更、Evaluation確定、Task分解 |
| Evaluator | Evidence登録、Evaluation確定、観測追加要求 | 次Outcome選択、Mission変更 |
| Wacha連携主体 | 実行結果・集計・外部活動の取り込み | Outcome達成、Project設定 |
| Runtime連携主体 | outbox取得・配送確認、認可されたcontext取得 | roleを偽装したドメイン変更 |

Manager / Worker / Reviewer / Acceptor / Operatorの操作先はWacha。Outcome Evaluatorはcompass。Improvement Agentによるモデル・Prompt・Skill改善は外部責務である。

認証からprincipal / 許可role / Project scopeを解決する。同じモデルでもStrategistとEvaluatorは別Run・別Role contextにする。Evaluation提出者のrunRefがOutcome活性化runRef、または紐づく成果物作成runRefと同じなら拒否する。正確な作成Runが不明な実接続は独立評価確認未完了として記録し、Lv6検証完了としない。

## 単体利用時の手動操作

役割はAgent専用ではなく、認可されたHumanにも割り当て可能。Humanの基本権限とは別にStrategist / Researcher / Evaluatorを付与し、同じCommandの検証を通す。Runがない場合の独立性はprincipalIdで検証し、null runRef同士を同一Runと判定しない。手動利用は正式機能だがLv6の介入ゼロ検証には数えない。詳細は[単体利用仕様](standalone-and-integration.md)。

## 外部Runtimeとのイベント接点

| 確定イベント | Runtimeが起動する役割 | compassへの出力 |
|---|---|---|
| IntentActivated | Researcher | ResearchCompletedまたは証拠不足の記録 |
| ResearchCompleted | Strategist | 初回Outcome、または追加Research Decision |
| OutcomeActivated（wachaモード） | 配送担当 / Wacha Manager | ExecutionRequestの受領結果 |
| OutcomeActivated（standaloneモード） | 必要なら外部の実行担当。手動利用では人 | 外部実行記録 / Evidence |
| ExecutionResultReceived | EvaluatorまたはResearcher | Evaluation / 追加観測 |
| EvaluationRecorded: insufficient_evidence | Researcher / 観測担当 | 新Evidence、再評価要求 |
| EvaluationRecorded: achieved / not_achieved | Strategist | NextDirection（次Outcome / Intent完了 / 放棄） |
| ObservationDue | Evaluator | 新Evaluation。起床は外部Runtimeが担当 |

compassはnextObservationAtを保存してcontextと一覧APIで公開する。Runtimeが時刻を監視してObservationDueを生成する。compass内にsleepやAgent schedulerを置かない。

contextにはProject snapshot、Intent、対象Outcome、固定Criterion、関連Research / Evidence / Evaluation / Decision、未解決事項、残り業務予算を含める。外部文書やWachaの本文はデータとして区別し、権限変更の命令として扱わない。

## 無限ループを防ぐ

業務上の試行予算はcompass、Runのtimeout・token・retry予算はRuntimeが所有する。maxOutcomeCyclesはIntentで活性化したOutcome数、maxObservationRequestsはOutcomeで発行した追加観測要求数を数える。取り込みやHTTP再送では増やさない。

上限到達、期限切れ、制約違反時は新規活性化を拒否し、理由付きDecisionとAttentionを保存する。証拠不足は成功に丸めず、Projectをpausedにする。自動復旧可能な条件が整えば事前方針の範囲内で復旧できるが、予算や権限をAgentが勝手に増やさない。

全ケースで必ず成功することをLv6の定義にしない。停止は正当な結果。ただし、人が途中で入力・承認・修復した実験を「介入ゼロで達成」と報告しない。

## 段階の呼び方

- P0〜P4：fakeで境界と往復を確認したローカルMVP。
- P5：実Wachaと外部Runtimeの契約接続。
- P6：実接続下の自律ループ受け入れ試験。

開発用scriptで固定された答えを順に投入しただけでは、Agentが自律判断した実証にはならない。
