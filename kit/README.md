# compass 実装開始キット

compassは「何を目指し、なぜ今それを選び、達成できたか」を管理するDirection Loop管理システムである。Projectは、人が現場の目的・現状・判断理由を把握する最上位コンテキストとする。

## 使い方

1. このディレクトリの内容を新しいcompassリポジトリのルートに置く。既存リポジトリでは既存AGENTS.mdを上書きせず、本キットの指示を整合させて取り込む。
2. Codexに[initial-codex-prompt.md](initial-codex-prompt.md)の本文を渡す。
3. [implementation-plan.md](docs/implementation-plan.md)のP0から順に実装する。最初の完成単位はP0〜P4のローカルMVP。P5〜P6は実サービス接続とLv6の検証である。
4. 各段階で受け入れ条件を確認し、実装済み・未接続・未検証を区別して記録する。

compass単体・Wacha単体・両者の連携を正式に支援する。単体利用とLv6の自律運転は別の達成条件とする。

このキットは実装仕様であり、アプリケーション本体やWachaの実API仕様ではない。

## 読む順序と仕様の所在

| 順序 | ファイル | 決めること |
|---|---|---|
| 1 | [AGENTS.md](AGENTS.md) | 実装エージェントの作業方針 |
| 2 | [architecture.md](docs/architecture.md) | 責務・構成・依存関係 |
| 2a | [standalone-and-integration.md](docs/standalone-and-integration.md) | 両製品の単体利用・任意連携 |
| 3 | [domain-model.md](docs/domain-model.md) | 中心概念・不変条件・状態遷移 |
| 4 | [project-model.md](docs/project-model.md) | Project情報と人向け画面 |
| 5 | [wacha-boundary.md](docs/wacha-boundary.md) | Wacha連携と障害時の契約 |
| 6 | [Wacha向け実装指示書](docs/wacha-implementation-instructions.md) | WachaのOutcome追加・Story連携・既存データ移行 |
| 7 | [autonomy-and-roles.md](docs/autonomy-and-roles.md) | Lv6・権限・外部Runtimeとの接点 |
| 8 | [api-and-persistence.md](docs/api-and-persistence.md) | API・保存・競合・冪等性 |
| 9 | [coding-rules.md](docs/coding-rules.md) | 実装・検証規約 |
| 10 | [acceptance-tests.md](docs/acceptance-tests.md) | 再現可能な受け入れシナリオ |
| 11 | [implementation-plan.md](docs/implementation-plan.md) | 着手順序・段階ごとの完了条件 |
| 12 | [initial-codex-prompt.md](initial-codex-prompt.md) | 実装開始時に渡す指示 |

## 確定要件と今回の設計判断

確定要件は、Direction / Execution / Runtimeの分離、Project中心の現場把握、9つの中心概念、最初のIntent投入以降の人の介入を不要にするLv6である。

本キットで追加した初期設計は、TypeScriptによる単一アプリ構成、PostgreSQL、Projectごとに同時に1つのActive Intent、Intentごとに同時に1つの進行中Outcome、HTTP API、outbox/inbox、停止予算である。これらは過去会話の確定事項ではなく、0から着手するためのデフォルト。既存コードに合理的な代替があればADRに理由と差分を残して変更できる。

参照元は「IT企業の組織と全体フロー」（会話ID: 6aa74d2c-7d4c-83ee-97bb-233436b1e112）と今回の依頼。過去の「compass＝Runtime」「WachaがOutcome評価を所有」という初期案は採用しない。最新の依頼を優先する。過去の生成物を網羅的に引き継ぐことは目的にしない。初期実装に不要な役割、階層、管理画面は切り捨てる。

## 全体の完成条件

Project HomeからMission → Intent → Outcome → Evidence → Evaluation → Decision → 次のOutcomeを辿れる。Wachaが切断されてもDirectionの履歴を読める。ローカルMVPは偽の外部サービスを明示して往復を実演できる。Lv6達成と呼べるのは、実Wacha・外部Runtimeとの接続下で、初回Intent以降の人の操作なしに失敗から再計画して成果評価まで到達した記録がある場合だけである。

## やらないこと

compass内でのTask管理、Claim、コードレビュー、デプロイ実行、Agent起動、モデル選択、Run再試行、スケジューラ、汎用エージェント基盤、組織管理・課金・マーケットプレイス、複雑なOKR階層、最初からのマイクロサービス化は対象外。
