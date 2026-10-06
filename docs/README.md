# Compass ドキュメント

## 確定した統合設計

- [Architecture Handoff](../compass-codex-architecture-handoff.md): 構成・責務境界・依存方向の正本。
- [ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md): Workspaceを戦略、Projectを実行の境界とする決定と移行の不変条件。
- [Direction・Workの境界](lv6-unification-design.md)
- [Research・Decision・ADR](research-decision-adr-design.md)

統合設計と実装状況は別に扱う。設計の確定は実装完了を意味しない。Workspaceは設計を確定したが、実装は`packages/organization`のWorkspace・Projectのモデル・保存・use caseと、全ProjectのWorkspaceへの所属、Mission等の正本のWorkspaceへの切替、Workspace Membership（保存・認可・use case・既存Project Membershipからの初期member移行）まで。Workspaceの公開入口はHuman向けWeb APIの参照（一覧・詳細・所属Project一覧）だけで、Projectの参照は所属`workspaceId`を返す。Mission等は既存のProjectの入出力で読み書きする。Intent・Outcome・成功条件はWorkspace所有で、`intent.workspace_id`・`outcome.workspace_id`へ保存する。Active IntentはWorkspaceにつき最大1件、OutcomeとIntentのWorkspace一致は複合FKで強制する。Intent/Outcome/Research/Decision/ADRのapplication use caseとRepositoryはWorkspace IDを直接受け取り、serverの内部`workspaceDirection`へ組み立てる。Workspace Directionの公開入口・Grant・Credentialは未接続。既存のProject入口とDirection Contextは`projectDirectionAdapter.ts`が所属Workspaceを明示解決し、所属Projectが1件の場合だけ接続する。複数Project（archivedも含む）のWorkspaceでは`CONFLICT`（`reason: workspace_direction_required`）で拒否し、Project権限で共有Directionを公開しない。Intent/Outcome/Research/Decisionの応答は`workspaceId`を持ち、`projectId`は持たない。Research Request/Result/Finding/Evidence/Synthesis・Direction Decision・ADR依頼/参照はWorkspace所有へ切替済み。Research/Decisionは`workspaceId`だけ、ADRは対象artifactの`projectId`・`repositoryId`も保持する。Evaluation・Execution還流・Runtime eventの保存scopeはProjectのまま。Directionのcanonical ActivityはWorkspace scopeへ切替済みで、Work・Project archive・明示記録は所属Workspace付きProject scope。Workspace Activityの公開入口・UI・Role Contextは未接続。下記「現在の実装と利用方法」の各文書は、保存scopeと公開入口を区別して現行動作を説明する。

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

- [移行計画](architecture-migration-plan.md): 現行のWorkspace移行と、Workspace導入前の構造移行でWachaへ登録したStory・Taskと受入条件。所有・scopeはADR 0001に従う。実装完了の記録ではない。
- [Workspace移行 影響マップ](workspace-migration-impact-map.md): Workspace移行での現行コード・DB・API・MCP・UI・Orchestratorの変更先、互換期間、既存ID保全、データ変換・rollbackの確認点。変更先の定義で、実装完了の記録ではない。
- [構造移行マッピング](architecture-migration-mapping.md): Workspace導入前の構造移行での全ファイルの配置・依存違反・互換性契約・移行単位。Workspace移行の変更先は含まない。
- [設計確認事項](planning/architecture-questions.md): 未確定事項。仕様として適用しない。
- [Project画面の情報設計と視覚方針](planning/project-screen-design.md): UI整理Storyの後続Taskが使う画面構成案。実装済みの仕様ではない。
- [Wacha Skill配布の改善メモ](planning/wacha-skill-delivery.md): Codex・ClaudeへのSkill登録を検討するための案。未採用。

現行文書へ過去の案・段階別の作業記録を併記しない。過去情報はGit履歴から参照する。
