# Direction・Workの境界

[Architecture Handoff](../compass-codex-architecture-handoff.md) に従う確定した統合設計。実装状況は [別文書](implementation-status.md) を参照する。

## 所有と入口

| 境界 | 所有する概念・責務 |
| --- | --- |
| Direction | Project / Intent / Outcome、達成したい状態とその理由 |
| Work | Story / Task / Claim / Review / Acceptance、仕事の状態 |
| Activity | Project・Systemの意味ある履歴、判断・成果物への参照 |
| Access | Principal / RoleGrant、Project単位の認可 |
| Server | Web UI / HTTP API / MCP、認証、application use caseへの接続、構成資産の配信 |
| Orchestrator | Project横断の現在状態確認、条件を満たす専門Roleの起動 |
| Ralph | Worker / Reviewerの実行ループ |

Humanの正規入口はWeb UI、AgentはMCP。Web APIとMCPは共通のapplication層へ委譲する。ServerのWeb・API・MCPは同一サーバーで提供し、OrchestratorとRalphは独立して実行・build・deployする。

## DirectionからWorkへの引き渡し

OutcomeはDirectionが所有し、Workは`outcomeId`を参照する。WorkにOutcome Entityを複製しない。Story / Taskへの分解と最終Acceptanceは`manager`の責務。Agent processの起動はWork Domainへ含めない。

Workでの受入完了はOutcome達成を意味しない。達成の評価には、固定した成功条件とEvidenceを使う。境界を越える参照はapplicationの契約を通し、相手のRepositoryやDB tableを直接操作しない。

## 実行と認可

Orchestratorは明示的な現在状態をコードで判定し、知的判断を専門Roleへ委譲する。Activity cursorをworkflow checkpointにしない。

1回の実行・操作Contextの`activeRole`は1つに固定する。Serverは認証した`principalId`、対象`projectId`、`activeRole`のGrantを検査し、複数Roleの権限を合算しない。

RalphのWorker / Reviewerは当面、別Principal・別Credentialとする。運用上の支障が具体化した場合に分離方式を再検討する。

自己レビュー禁止、自己受入禁止、Claim所有者・期限、Task状態遷移はWork Domain / Applicationで強制する。Policy文書やAgentの指示遵守に依存しない。

## Activityとログ

| 種類 | 内容 | 保存・利用 |
| --- | --- | --- |
| Operational Log | request、error、latency、trace | stdout・ログ基盤。通常のAgent Contextに含めない |
| Change Log | Claim・Task状態遷移など正確な変更 | 構造化・追記型 |
| Activity | 何が起き、何が分かり、何が決まったか | 独立したActivity package、DB保存、原則追記型 |

Activityには`scope`、Project scopeの場合の`projectId`、`type`、`principalId`、`role`、必須の`summary`、任意のMarkdown `body`、`refs`、`occurredAt`、`cursor`を持たせる。`runId`は持たせない。訂正は訂正Activityの追加を優先する。

重要な状態変更はapplication / domain event等からcanonical Activityを自動生成できる構造とする。調査・判断理由・引き継ぎはAgentが明示的に記録できる。Repository / Docsが正本となる成果物にはResource・path・revision等の参照を保持し、本文を複製しない。Compassが管理するProject別の判断・評価等は該当Domainに保持できる。Activityには意味のある要約・説明とEntity参照を残す。

## 依存方向

Infrastructure → Application → Domain。DomainはWeb、MCP SDK、DB、Agent provider、配置先に依存しない。InterfaceはApplication Use Caseを通す。

主要packageは`direction` / `work` / `activity` / `access`。`shared`はID・時刻・汎用結果型等の最小限に限定する。Task / Claim / Reviewを別Bounded Contextへ先に分割しない。`apps/`、`packages/artifact`、静的な`agents/`、空の将来用ディレクトリを作らない。
