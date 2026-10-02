# Wacha向けアーキテクチャ移行計画

本書は [確定した統合設計](../compass-codex-architecture-handoff.md) を実装するための作業計画。WachaのCompass ProjectにStory `99bfa15a-c27b-4c4f-8a39-37764760a466` とTask 10件を登録済み。登録は実装・実行の完了を意味しない。

## 移行元と移行先

| 現在のコード・資産 | 移行先 | 守る境界 |
| --- | --- | --- |
| 起動・Web UI・HTTP / MCP adapter・DI（`server/`へ移行済み） | `server/` | Web / API / MCPは共通Use Caseへ接続 |
| Project / Intent / Outcome・Direction use case / repository | `packages/direction/` | OutcomeをWorkへ複製しない |
| `server/src/**/execution/`のStory / Task / Claim等 | `packages/work/` | 状態遷移とClaimの不変条件を保持 |
| Principal / Grant / Credential / Human認可 | `packages/access/`とServerの認証adapter | Accessの業務規則とtransportを分離 |
| 新たな意味的履歴のモデル・保存・参照 | `packages/activity/` | Change Log・Operational Logとは別概念 |
| `agent/<role>.md`、`agent/role-policy.md` | `roles/`、`policies/` | `manager`名を維持し、providerへ本文を埋め込まない |
| WachaのFileSkillRepository / FileKnowledgeRepository等 | `skills/`、`knowledge/`と配信adapter | Skillは認可しない。Knowledgeは共通知識のみ |
| Project横断の状態確認・Role起動 | `orchestrator/` | 現在状態を判定し専門判断をRoleへ委譲 |
| agent-foundationのRalph | `ralph/` | Worker / Reviewerループ、MCPからContext取得 |

参照元は`/Users/aokayama/git/wacha`、`/Users/aokayama/git/shirube`、`/Users/aokayama/git/agent-foundation`。Compassへ取り込み済みの機能を重複移植しない。上表は責務単位の対応。ファイル全件の移行先・依存違反・互換性契約・移行単位は [構造移行マッピング](architecture-migration-mapping.md) で定義する。

## 作業順と受入条件

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

## 具体化した項目

workspace・build（npm workspaces）、`activeRole`のtransport・互換期間、command receiptとの対応、Goal / Vision・evaluatorの移行中の扱いは [構造移行マッピング](architecture-migration-mapping.md) で確定した。`manager`名は維持する。各Taskで引き続き具体化する項目は次のとおり。

- RalphのWorker / Reviewerは別Principal・別Credentialで接続する。命名・発行・Grantの割当を具体化し、同じPrincipalでの自己レビュー・自己受入を拒否することを検証する。
- 現在状態Queryで未処理・実行中・再試行待ちを識別する契約。Activityで代用しない。
- canonical Activityの重複抑止・状態更新との整合性・認可付きcursor取得。
- Research等の保存先を内容と所有責務で分類する。Compass所有のProject別レコードは保持できる。外部を正本とする内容だけ移行・参照切替を設計し、既存Evidence・Decision・Evaluationの参照関係を壊さない。

未確定の製品判断は [設計確認事項](planning/architecture-questions.md) に分離する。確認前に既存Role・DBレコードを削除しない。
