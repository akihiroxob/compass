# Compass 開発方針

## 仕様の正本

- ユーザーの最新の明示指示を最優先する。
- `compass-codex-architecture-handoff.md` を統合アーキテクチャの正本とする。
- 現行文書の入口は `docs/README.md`。確定した設計と現在の実装状況を区別する。
- 現行文書へ過去の案・作業履歴を残さない。過去情報はGit履歴で参照する。未確定事項は `docs/planning/` へ分離し、確定要件として扱わない。
- 今回の反映はドキュメントとWachaへのStory・Task登録のみ。コード・DB・設定・実行時に配信するRole文書の変更は登録済みTaskで実施する。移行計画と登録状況は `docs/architecture-migration-plan.md` を参照し、Task登録と実装完了を混同しない。
- リリース前のCompass開発DBは破棄・再作成してよい。schema変更時のDROP・DBファイル削除を許可し、旧DBからのデータ移行・既存ID保全・旧Credentialの継続・旧クライアント互換を必須にしない。新規DBでの正しい構造・永続化・認可・業務規則を検証する。開発用Wachaのデータは別管理とする。

## 構成と責務

- Compassは方向管理とWachaの実行管理を統合するモノレポ・製品とする。
- `server/`・`orchestrator/`・`ralph/` は独立して実行・build・deployできるシステム。ServerのWeb UI・API・MCPは同じ起動コマンド・同じサーバーで提供する。
- 主要Bounded Contextは `packages/direction`・`work`・`activity`・`access`。Workspace移行で`packages/organization`を加える。`apps/`を使わず、空の構造を先に作らない。
- Workspaceは戦略、Projectは実行の境界とする（`docs/adr/0001-workspace-project-boundary.md`）。Workspace / ProjectはOrganization、Intent / OutcomeはWorkspace scopeのDirection、Story / Task / Claim / Review / AcceptanceはProject scopeのWorkが所有する。WorkはOutcomeを参照し、Entityを複製しない。Workspaceは移行Taskで段階的に実装し、現況は `docs/implementation-status.md` を参照する。
- Orchestratorは現在状態から専門Roleを起動し、知的判断をRoleへ委譲する。RalphはWorker / Reviewerの実行ループを担う。
- Activityは意味のある履歴であり、workflow checkpointにしない。Operational Log / Change Log / Activityを区別する。
- Project別の情報は内容と所有責務で保存先を決める。Compassが所有する判断・評価等のレコードは内部に保持できる。Repository / Docsが正本の成果物は参照を保持し、本文を二重管理しない。KnowledgeはAgent System共通知識だけを置く。
- Infrastructure → Application → Domainの依存方向を守る。`shared`に業務概念を集めない。

## Roleと認可

- PrincipalとRoleを分離する。1回の実行・操作ContextではactiveRoleを1つに固定し、ServerがProject単位のGrantを検証する。
- RalphのWorker / Reviewerは当面、別Principal・別Credentialで運用する。運用上の支障が具体化した場合に再検討する。
- 認可はAccess、Claim所有・期限・状態遷移・自己レビュー禁止・自己受入禁止はWorkで強制する。
- Roleは責務、Skillは再利用手順。Role → Skillの参照とし、Skillへ`allowRoles`を持たせない。Tool metadataはnamespace付き識別子を使う。
- Role / Skill / Knowledge / PolicyはGit管理し、実行システムはMCPから必要時にContextを取得する。

## 操作主体と公開経路

- Humanの通常操作はWeb UI、AgentはMCPを正規入口とする。Human管理操作をMCPへ無条件に公開しない。
- Web APIとMCPは同じapplication層へ委譲し、業務規則を入口ごとに重複させない。
- CLIは開発・移行・障害復旧・自動検証など保守用途に限定する。
- リモート配置を想定し、HumanがサーバーのfilesystemやSQLiteへ直接アクセスする設計にしない。

## 作業規約

- 作業前に方針を短く示し、日本語で簡潔に報告する。
- 既存設計・命名・テスト方針を調査し、全体の概念・責務・利用導線との整合を確認する。目先の問題だけに合わせた局所最適を避ける。
- インクリメンタルに進め、今必要な要件に絞る（YAGNI）。仕組みは理解しやすく単純に保つ（KISS）。
- 保守性と整合性のために必要なら広範囲を改修する。差分の小ささ自体を目的にせず、不要な大規模リファクタリングや将来を見越した先回り実装は避ける。
- 参照元は `/Users/aokayama/git/wacha`・`/Users/aokayama/git/shirube`・`/Users/aokayama/git/agent-foundation`。取り込み済み機能を重複移植しない。
- 現在のHono / React・Vite / SQLite・Kysely構成を基準とし、技術変更を構成例だけから自動採用しない。
- 変更後は関連テスト・型チェック・lint・buildを可能な範囲で実行し、未実施と失敗を明示する。
- 実装済み・未接続・未検証を区別する。模擬実行を自律運転の実証と扱わない。
