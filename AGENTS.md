# Compass 開発方針

## 仕様の優先順位

- ユーザーの最新の明示指示を最優先する。
- `kit/additional-doc.md` を構想・責務境界の主な根拠とする。既存kitと矛盾する場合は追加資料を優先する。
- 追加資料に「候補」「草案」「未決定」とある事項は、確定事項として扱わない。元のChatGPT会話との一致は、この資料だけから保証できない。
- その他の `kit/` 文書は補助仕様。別リポジトリ前提、技術構成のデフォルト、P0〜P4の一括実装指示をそのまま適用しない。

## 統合と実装範囲

- 最終的にCompassとして方向管理（旧Shirube）とWachaの実行管理をモノレポ・統一された製品へまとめる。
- Direction / Execution / Runtime / Improvementの責務境界を保つ。責務分離はリポジトリや製品の分離を意味しない。
- Projectの作成・保存・一覧・詳細から着手し、Intent、Outcomeと成功条件の作成へ段階的に進める。各段階でユーザーと認識を合わせる。
- ProjectはMission / Vision / Principles / Constraints / Repositories / Resourcesを持つ構想。最初の必須入力項目と、段階ごとの実装範囲は区別する。
- Wacha統合・自律実行・評価・改善ループを初回の完成条件に含めない。

## Wachaから引き継ぐ構成

- 参照コードは `/Users/aokayama/git/wacha`。既存の設計・命名・テスト方針を調査して活用する。
- MCPとWebServerを一つの起動コマンドで同時に利用可能にする構成を維持する。
- Wachaの現行方式はHonoの同一サーバー・同一ポートで `/mcp`、`/api`、Web UIを提供するもの。`npm start` は画面のビルド後にサーバーを起動する。
- WebとMCPの業務処理は共通のアプリケーション層へ委譲する。
- kitのNext.js / PostgreSQL / Prisma案を自動採用せず、WachaのHono / React・Vite / SQLite・Kysely構成を基準に検討する。

## 作業規約

- 作業前に方針を短く示し、日本語で簡潔に報告する。
- 不要な大規模リファクタリングを避ける。
- 変更後は関連するテスト・型チェック・lint・buildを可能な範囲で実行し、未実施と失敗を明示する。
- 実装済み・未接続・未検証を区別し、模擬実行を自律運転の実証と扱わない。
