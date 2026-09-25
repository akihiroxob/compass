# compass 実装エージェントへの指示

## 守る目的

compassはDirection Loopを永続化・検証・公開する。WachaはExecution Loop、Runtime/OrchestratorはAgentの起動・実行制御を所有する。3者を混ぜない。

Projectは人の現場把握の入口。Mission / Vision / Principles / Repositories / Resources / Active Intent / Active Outcomes / Recent Decisions / Learnings / Execution Summary / Activityを実装対象とする。

両製品は相手なしで利用できる。standalone-and-integration.mdを読み、compassの単体操作とWachaのlocal Outcomeを連携の付属デモにしない。

## 作業手順

- READMEの順序で仕様を読み、implementation-planのP0から進める。
- 作業前に短く方針を述べ、日本語で簡潔に報告する。
- 既存の設計・命名・テスト・パッケージ管理を優先。空リポジトリではarchitectureのデフォルトを使う。
- 要件がない細部は小さい選択を行い記録する。既定値がある事項について確認待ちで止まらない。
- ユーザーの最新の明示指示を優先。仕様の責務変更が必要なら理由と影響を明示する。
- 状態遷移と権限検証はサーバーのアプリケーション層で行う。UIやAgentの善意に任せない。
- SuccessCriterionを実行開始後に変更しない。Execution完了だけでOutcomeを達成扱いしない。
- Evidence不足はinsufficient_evidence。成功・失敗を推測で補わない。
- Decision / Evaluation / Evidenceと相関IDを残し、再起動後も継続可能にする。
- ステップごとに必要なテスト・型チェック・lint・buildを実行。未実行や失敗を隠さない。
- 過度なリファクタリング、将来用の抽象化、Task/Run管理機能の追加はしない。
- 実Wachaの仕様・認証が未提供ならfake adapterで進め、連携済みと表示しない。
- ドキュメントと状態enum・スキーマ・画面がずれたら同じ変更で修正する。

## 完了報告

到達した段階、動作確認方法、実行した検証、未接続の依存、残る段階を示す。MVPをLv6達成と呼ばない。実装した起動コマンドと.env.exampleをREADMEへ追記する。

仕様の詳細はdocsに置き、このファイルには重複した状態遷移やAPI一覧を増やさない。
