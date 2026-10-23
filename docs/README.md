# Compass ドキュメント

## 確定した統合設計

- [Architecture Handoff](../compass-codex-architecture-handoff.md): 構成・責務境界・依存方向の正本。
- [ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md): Workspaceを戦略、Projectを実行の境界とする決定と移行の不変条件。
- [Direction・Workの境界](lv6-unification-design.md)
- [Research・Decision・ADR](research-decision-adr-design.md)

統合設計と実装状況は別に扱う。設計の確定は実装完了を意味しない。Workspaceは設計を確定したが、実装は`packages/organization`のWorkspace・Projectのモデル・保存・use caseと、全ProjectのWorkspaceへの所属、Mission等の正本のWorkspaceへの切替、Workspace Membership（保存・認可・use case）まで。schemaは新規DBの定義だけで、旧Projectの戦略値・Membershipを補完する起動時migrationは無い。Workspaceの公開入口はHuman向けWeb APIの作成・参照（一覧・詳細・所属Project一覧）・Mission等の更新・既存WorkspaceへのProject追加・archiveと、それを使うWeb UIのWorkspace Selector・Shell・作成/編集/Project追加/archiveの導線と、Workspace「設定」のmember・Direction Role Grant・Workspace Credentialの管理（Web API・Web UI）で、Workspace管理のMCPは無い。Projectの参照は所属`workspaceId`を返す。Mission等はWorkspace Membershipのadministrator以上がWorkspaceの更新で変更し、Projectの更新（Web API・MCP）は受け取らない。WorkspaceのarchiveはWorkspace ownerだけが行い、Projectのarchiveは所属Workspaceの状態を変えない。Intent・Outcome・成功条件はWorkspace所有で、`intent.workspace_id`・`outcome.workspace_id`へ保存する。Active IntentはWorkspaceにつき最大1件、OutcomeとIntentのWorkspace一致は複合FKで強制する。Intent/Outcome/Research/Decision/ADR/Evaluation/Runtimeのapplication use caseとRepositoryはWorkspace IDを直接受け取り、serverの内部`workspaceDirection`へ組み立てる。Workspace Directionの公開入口（Web API `/api/workspaces/:workspaceId/…`・MCP toolの`workspaceId`入力・Strategist / Researcher / Evaluator Context）は接続済みで、HumanはWorkspace Membership、AgentはWorkspace Role Grant（Workspace Agent Credential）、Runtime eventはWorkspace Runtime Credentialで認可する。Workspace Role Grantの保存・付与/取消/一覧と明示scope認可は接続済みで、HumanはWorkspace Membership（参照はviewer、付与・取消はadministrator以上）でWeb API・Web UIから管理する。Agent / Runtime CredentialはWorkspace / Projectの明示scopeで保存・認証し、Workspace Credentialの管理はWeb API・Web UIのWorkspace「設定」に接続済み（[Credential](step-6-human-auth-design.md#agentruntime-credential)）。新規Project GrantはManager・Worker・Reviewerとtrusted-local用`runtime`だけを受け付け、Workの参照・更新もExecution Roleだけを認可する。Direction activeRoleと旧Direction/Runtime GrantによるWork参照を拒否する（[Agent認可](step-4-strategist-role-design.md)）。Project配下のDirection経路とMCPの`projectId`入力は廃止し、Project IDをWorkspace IDとして解釈しない。Project Membership・Project Grant・Project CredentialからWorkspace Directionは継承しない。Execution Summary/EvidenceだけはProject固有の記録としてProjectの入口（Project Membership・Project Runtime Credential）に残る。Story作成時のOutcome参照は、Projectの所属Workspace・Constraints・Repository（Project execution context）と所属WorkspaceのOutcome snapshotを読み、そのProjectがOutcomeのTargetであることを検査する（Target外は`CONFLICT`・`reason: not_target_project`）。ManagerはProject manager Grantだけで、MCP `get_outcome_handoff_context`からTargetのOutcome本文・成功条件を読む（Workspace Direction Grantは継承しない）。Workspace単位の`get_workspace_orchestration_state`はWorkspace Runtime Credentialで公開済みで、OrchestratorはこれをWorkspace Runtime Credentialで読み、dispatch規則（S08-02）でWorkspace Role・Target ProjectのmanagerをscopeごとのAgent Credential設定で起動する（S08-03）。Project基準のOrchestration State（`get_orchestration_state`）は除いた。Intent/Outcome/Research/Decision/Evaluation/Runtime eventの応答は`workspaceId`を持ち、`projectId`は持たない。Research Request/Result/Finding/Evidence/Synthesis・Direction Decision・ADR依頼/参照はWorkspace所有へ切替済み。Research/Decisionは`workspaceId`だけ、ADRは対象artifactの`projectId`・`repositoryId`も保持する。Evaluation・Runtime eventは`workspaceId`だけで保存・取得し、Execution Summary/Evidenceは`workspaceId`と発生元`projectId`を併せ持つ。SummaryはOutcome・Projectごとに1行、Evidenceの一意性はOutcome・Project・種別・URI・versionで保つ。Directionのcanonical ActivityはWorkspace scopeへ切替済みで、Work・Project archive・明示記録は所属Workspace付きProject scope。Workspace Activityの明示記録・参照はMCP（Workspace Role Grant）とWeb API（Workspace Membership）・Web UIのWorkspace「記録」で接続済み。下記「現在の実装と利用方法」の各文書は、保存scopeと公開入口を区別して現行動作を説明する。

## 現在の実装と利用方法

- [Managerのブラウザ検証データ](browser-verification.md): 対象SHAの専用DB準備・シナリオ・確認範囲。
- [README](../README.md): 起動・接続・操作・検証。
- [Project](step-1-project-design.md)
- [Intent](step-2-intent-design.md)
- [Outcome・成功条件](step-3-outcome-design.md)
- [Agent認可・Instruction配信](step-4-strategist-role-design.md)
- [Project archive](step-5-project-archive-design.md)
- [Human認証・Membership・Credential](step-6-human-auth-design.md)
- [Web UIの構成](web-ui.md): 配置と依存、共通の基本部品（`components/ui`）のAPI・size契約、SCSSのpartialの所有、`npm run check:ui`の検査範囲と機械的に保証しない範囲。
- [実装状況](implementation-status.md): 公開入口・検証範囲・未接続の現況。[Workspace移行の受入検証](implementation-status.md#workspace移行の受入検証)に新規DB・実ブラウザ・独立起動で確認した範囲とfixtureの限界を記す。

## Wachaへの引き継ぎ

- [移行計画](architecture-migration-plan.md): 現行のWorkspace移行と、Workspace導入前の構造移行でWachaへ登録したStory・Taskと受入条件。所有・scopeはADR 0001に従う。実装完了の記録ではない。
- [Workspace移行 影響マップ](workspace-migration-impact-map.md): Workspace移行での現行コード・DB・API・MCP・UI・Orchestratorの変更先、互換期間、既存ID保全、データ変換・rollbackの確認点。変更先の定義で、実装完了の記録ではない。
- [構造移行マッピング](architecture-migration-mapping.md): Workspace導入前の構造移行での全ファイルの配置・依存違反・互換性契約・移行単位。Workspace移行の変更先は含まない。
- [設計確認事項](planning/architecture-questions.md): 未確定事項。仕様として適用しない。
- [Project画面の情報設計と視覚方針](planning/project-screen-design.md): UI整理Storyの後続Taskが使う画面構成案。実装済みの仕様ではない。
- [Wacha Skill配布の改善メモ](planning/wacha-skill-delivery.md): Codex・ClaudeへのSkill登録を検討するための案。未採用。
- [Story分割・AC・検証依存の再発防止案](planning/acceptance-dependency-prevention.md): 検証可能な増分、Givenの成立確認、依存制御と停止後の自律的な回復の提案。依存制御等は未実装。

現行文書へ過去の案・段階別の作業記録を併記しない。過去情報はGit履歴から参照する。
