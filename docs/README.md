# Compass ドキュメント

## 確定した統合設計

- [Architecture Handoff](../compass-codex-architecture-handoff.md): 構成・責務境界・依存方向の正本。
- [ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md): Workspaceを戦略、Projectを実行の境界とする決定と移行の不変条件。
- [Direction・Workの境界](lv6-unification-design.md)
- [Research・Decision・ADR](research-decision-adr-design.md)

統合設計と実装状況は別に扱う。設計の確定は実装完了を意味しない。Workspaceは設計を確定したが未実装で、現在の実装はProjectがDirectionも兼ねる。下記「現在の実装と利用方法」の各文書は現行のProject単位の動作を説明する。

## 現在の実装と利用方法

- [README](../README.md): 起動・接続・操作・検証。
- [Project](step-1-project-design.md)
- [Intent](step-2-intent-design.md)
- [Outcome・成功条件](step-3-outcome-design.md)
- [Agent認可・Instruction配信](step-4-strategist-role-design.md)
- [Project archive](step-5-project-archive-design.md)
- [Human認証・Membership・Credential](step-6-human-auth-design.md)
- [実装状況](implementation-status.md)

## Wachaへの引き継ぎ

- [移行計画](architecture-migration-plan.md): Wachaへ登録したStory・Task（Workspace移行を含む）と受入条件。実装完了の記録ではない。
- [構造移行マッピング](architecture-migration-mapping.md): 全ファイルの移行先・依存違反・互換性契約・移行単位。
- [設計確認事項](planning/architecture-questions.md): 未確定事項。仕様として適用しない。
- [Project画面の情報設計と視覚方針](planning/project-screen-design.md): UI整理Storyの後続Taskが使う画面構成案。実装済みの仕様ではない。
- [Wacha Skill配布の改善メモ](planning/wacha-skill-delivery.md): Codex・ClaudeへのSkill登録を検討するための案。未採用。

現行文書へ過去の案・段階別の作業記録を併記しない。過去情報はGit履歴から参照する。
