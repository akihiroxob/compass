# Wacha向けアーキテクチャ移行計画

本書は [統合設計](../compass-codex-architecture-handoff.md) と [ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md) を実装するための作業計画。現行の移行は [Workspace移行](#workspace移行)。所有関係・scopeの正本はADR 0001とし、本書の表と食い違う場合はADRに従う。WachaへのStory・Task登録は実装・実行の完了を意味しない。

## 構造移行（Workspace移行前）

WachaのCompass ProjectにStory `99bfa15a-c27b-4c4f-8a39-37764760a466` とTask 10件を登録し、参照元のコードをモノレポの独立システムとBounded Contextへ配置した。次の表はこの構造移行での配置で、Workspace導入前の実装の現況を示す。Workspace移行後の所有先は右列とADR 0001に従う。

| 対象 | 構造移行での配置（現況） | 守る境界 | Workspace移行での変更 |
| --- | --- | --- | --- |
| 起動・Web UI・HTTP / MCP adapter・DI | `server/` | Web / API / MCPは共通Use Caseへ接続 | 入口にWorkspace / Project scopeを明示する |
| Project | `packages/direction/`（Workspace移行のS02-03で`packages/organization/`へ移設済み） | — | Workspace・ProjectResourceとともに`packages/organization/`が所有する |
| Intent / Outcome・Direction use case / repository | `packages/direction/`（Project scope） | OutcomeをWorkへ複製しない | Workspace scopeへ移し、OutcomeTargetProjectを加える |
| Story / Task / Claim等 | `packages/work/` | 状態遷移とClaimの不変条件を保持 | Project scopeを維持する |
| Principal / Grant / Credential / Human認可 | `packages/access/`とServerの認証adapter | Accessの業務規則とtransportを分離 | Workspace / ProjectのMembership・Role Grant・Credentialを分ける |
| 意味的履歴のモデル・保存・参照 | `packages/activity/`（system / workspace / project scope。Direction canonicalはWorkspace、Work等は所属Workspace付きProject） | Change Log・Operational Logとは別概念 | Web UIへWorkspace Activityを接続する（Workspace Role Contextは接続済み） |
| `agent/<role>.md`、`agent/role-policy.md` | `roles/`、`policies/` | `manager`名を維持し、providerへ本文を埋め込まない | なし（Role Contextのscope分離・Project Role ContextのWorkspace要約・関連Outcome・OrchestratorのWorkspace Role起動の`get_workspace_role_context`への切替は接続済み） |
| WachaのFileSkillRepository / FileKnowledgeRepository等 | `skills/`、`knowledge/`と配信adapter | Skillは認可しない。Knowledgeは共通知識のみ | なし |
| 状態確認・Role起動 | `orchestrator/`（Project単位の状態を横断して確認） | 現在状態を判定し専門判断をRoleへ委譲 | Workspace単位の状態でWorkspace RoleとProjectのmanagerを起動する |
| agent-foundationのRalph | `ralph/` | Worker / Reviewerループ、MCPからContext取得 | Project scopeの実行ループのまま。Workspaceを直接所有・選択しない |

参照元は`/Users/aokayama/git/wacha`、`/Users/aokayama/git/shirube`、`/Users/aokayama/git/agent-foundation`。Compassへ取り込み済みの機能を重複移植しない。構造移行でのファイル全件の配置・依存違反・互換性契約・移行単位は [構造移行マッピング](architecture-migration-mapping.md) に記す。Workspace移行での変更先は同マッピングではなく、ADR 0001と[Workspace移行 影響マップ](workspace-migration-impact-map.md)で定める。

### 作業順と受入条件

| 順 | Wachaで行う作業 | 受入条件 |
| --- | --- | --- |
| 1 | 各参照元のコード・テスト・配置を調査し、全ファイル対応と依存関係を整理 | 曖昧な責務・違反・互換性対象を列挙。確認事項を解決 |
| 2 | Server / Direction / Work / Accessの最小単位の分離 | Domainがframeworkに依存せず、Web / MCP・認証・Claim・既存DBの回帰検証が通る |
| 3 | activeRoleと構成資産・Context API | Grantの合算を拒否。自己レビュー・自己受入禁止を維持。Role本文・Skill・Knowledgeを必要時に取得 |
| 4 | Activity・ProjectResourceと成果物参照を実装 | scope・必須summary・Principal / Role・参照・cursorを検証。runIdと成果物本文を複製しない |
| 5 | Orchestratorの現在状態Query・Role起動条件を実装 | 再起動や並行観測で重複作業を作らない。Activity cursorに依存せず、Researchの要否をStrategistが判断 |
| 6 | Ralphを移行しServerと接続 | 独立して実行・build・deployできる。Worker / Reviewerが別Principal・別Credentialの認可されたContextで実行 |
| 7 | 構造移行後の回帰と独立起動を検証 | 既存Lv6 Task 38の一巡結果を踏まえ、移行後のWeb / MCP・認可・実行境界を検証する |

各Taskで必要なコードだけを移し、空ディレクトリを先に作らない。変更対象のテスト、型チェック、lint、buildと文書更新を同じTaskで実施する。模擬実行・実接続・自律運転を区別する。

### 具体化した項目

workspace・build（npm workspaces）、`activeRole`のtransport・互換期間、command receiptとの対応、Goal / Vision・evaluatorの移行中の扱いは [構造移行マッピング](architecture-migration-mapping.md) で確定した。`manager`名は維持する。各Taskで引き続き具体化する項目は次のとおり。

- RalphのWorker / Reviewerは別Principal・別Credentialで接続する。命名・発行・Grantの割当と設定は09で具体化した（[Ralph](../ralph/README.md)）。同じPrincipalでの自己レビュー・自己受入はWorkが拒否する。
- 未処理・実行中・再試行待ちの識別は08で実装した。未処理はServerの現在状態Query（`get_orchestration_state`）、実行中・再試行待ちはOrchestratorの起動記録で識別し、Activityで代用しない（[Orchestrator](../orchestrator/README.md)）。
- canonical Activityの重複抑止・状態更新との整合性・認可付きcursor取得。
- Research等の保存先を内容と所有責務で分類する。Compass所有のレコードは保持できる（Workspace移行後のscopeはADR 0001に従う）。外部を正本とする内容だけ移行・参照切替を設計し、既存Evidence・Decision・Evaluationの参照関係を壊さない。

未確定の製品判断は [設計確認事項](planning/architecture-questions.md) に分離する。確認前に既存Role・DBレコードを削除しない。

## Workspace移行

[ADR 0001 WorkspaceとProjectの境界](adr/0001-workspace-project-boundary.md) を実装するため、WachaのCompass ProjectにStory 01〜12とTaskを登録済み。登録は実装完了を意味しない。順序はStory番号と各Taskの前提で示し、Wachaは依存を自動制御しない。各Taskのファイル単位の変更先と検証条件は[影響マップ](workspace-migration-impact-map.md)に記す。

リリース前の開発DBは破棄・再作成できる。tableのDROP・DB file削除を許可し、旧DBからのデータ変換、既存ID・Credential・cursorの引継ぎ、旧server・旧クライアントとの互換は必須にしない。空DBでの初期化・保存・再起動と、現在の認可・業務契約を検証する。schema変更に必要な旧列・旧table・互換コードの整理は各実装Taskで行える。

Activityの移行ではStory番号およびWorkspace handoff v2の推奨順と実施順が異なる。既存のDirection通知がProject IDのみを持ち、Activity追記が業務変更と同じtransactionで行われるため、Story 02受入後にS07-01でworkspace scopeとDirection canonical Activityを切り替え、S07-01受入後にS03-01のDirection通知を切り替える。Wachaの両Taskの前提もこの順序に更新済み。

認可の移行はS03-01〜03（DirectionのWorkspace保存・application集約）→S06-02〜03（Workspace Role Grant・Credential）→S03-04（Direction公開入口）→S06-04（公開済み入口の横断検証）の順とする。S03-01〜03で権限未整備のWorkspace Contextを公開しない。認可付きWorkspace Activity入口のS07-02はS03-01〜03とS06-02〜03の後に接続する。Workspace Role ContextはS07-03〜04で個別に認可検証する。

UIはS09-01で既存Project画面に対するSCSS基盤を確認し、S09-02でWorkspace画面を接続した時に共通トークン・部品がWorkspaceとProjectの双方へ反映されることを実ブラウザで確認する。

有効なOutcomeのTarget Projectがarchiveされ、未完了のExecutionが残る場合は、WorkspaceのStrategistが再計画する。Target・既存Story・成果・Evidenceの参照は保持し、Targetの解除・再割当・Outcome見直しをStrategistが判断する。archive前に評価可能な成果が揃っていればEvaluatorへ進める。この契約はS04-01・S05-02・S08-01〜02の受入条件に登録済み。

| Story | 内容 | 主な受入条件 |
| --- | --- | --- |
| 01 | 移行の契約（ADR）と、コード・DB・API・MCP・UIの影響マップ | 業務挙動を変えない。影響マップは現行コードとテストを根拠にする |
| 02 | Workspace・`packages/organization`・Project所属 | 空DBからWorkspaceとProjectを保存でき、全Projectが1つのWorkspaceに属する |
| 03 | DirectionのWorkspace scope化 | 根拠と参照の整合を保ち、`project_id`列にWorkspace IDを保存しない |
| 04 | OutcomeTargetProjectとProject別Story handoff | 同一WorkspaceのTargetだけを許可し、target外・別Workspaceを拒否する |
| 05 | 全Target ProjectのExecution還流とOutcome評価 | 一部Projectの完了だけで評価・達成にしない |
| 06 | Workspace / ProjectのMembership・Role Grant・Credential分離 | Role継承を作らず、activeRoleとscopeの不一致を拒否する |
| 07 | Workspace / Project ActivityとRole Context | scope不整合を拒否し、Change Log・Operational Logと混同しない |
| 08 | Workspace単位の現在状態とOrchestrator dispatch | Project選択をOrchestratorで推論せず、archive済みへdispatchしない |
| 09〜11 | Workspace UI（Shell・切替、Direction / Project画面、Activity・Agent・設定） | 実データと権限を反映し、プロトタイプの固定値を持ち込まない |
| 12 | 旧Project前提の除去と統合回帰 | 新規DB・独立起動・実ブラウザで検証する |
