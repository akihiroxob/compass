# アーキテクチャレビュー（Agentだけで回す前提）

設計検討用のレビュー。確定した設計・実装済みの仕様としては扱わない。対象は2026-11-12時点の`feat/fit2cloudflare`ブランチのコードと文書。現状と改善後の比較図は [architecture-review-visual.html](architecture-review-visual.html)、現行の構成は [Compassの全体像とAgentの動き](../architecture-overview.md) を参照する。

## 総評

- 筋が良い点: 状態・認可・業務規則をServerへ集め、Agentの起動を外に出した分離。現在状態だけで起動を判断する方式。成功条件の固定と、Task受入とOutcome達成の区別。
- 根本の弱点: 守っているのは手順の整合（Claimの所有、自己レビューの禁止）で、Agentが誤誘導・乗っ取りを受けた場合に被害を閉じ込める仕組みがない。Agentを「間違えるが誠実な作業者」としてだけ扱っている。
- 進め方の弱点: 契約と文書は精密だが、実AgentでIntentからEvaluationまで通した実績がない。ループに人手が要る切れ目も残る。

## 懸念

| 重大度 | 懸念 | 確認した事実 | 改善の方向 |
| --- | --- | --- | --- |
| 重大 | 規則の自己改変 | `roles/`・`skills/`・`policies/`がWorkerの作業対象と同じRepositoryにある。変更パスの制限は製品側に無い。Reviewer（Agent）がmergeし、Workers配置では`main`へのpushがそのまま配置になる | 規則・CI・配置設定を保護パスにし、変更はHumanが承認する |
| 重大 | 書込み権限とshellの同居 | `ralph/examples/config.json`は`dangerouslySkipPermissions: true`。PR作成・mergeはAgentが`gh`で行う手順（`knowledge/tips/github-workflow.md`）で、GitHubの書込み権限がAgentの実行環境に要る。Serverの照合はmergeの後 | Agentをsandboxへ入れ、MCP以外の通信を遮断する。commit・PR・mergeはホスト側のRalphが行う |
| 高 | 職務分離がCompassの中だけ | Worker・Reviewer・Managerが同じGitHubアカウント・tokenを使ってよい。自己レビューの禁止はCompassのPrincipal単位 | GitHub側でも`main`への直接pushを禁じ、mergeできる主体を1つに絞る |
| 高 | 停止と上限が無い | ServerにWorkspaceの一時停止・費用の上限が無い。Orchestratorの再試行上限はdispatch key単位。止める手段はプロセス停止かarchive | Workspace単位の一時停止と上限をServerの状態にし、OrchestratorとRalphが読む |
| 高 | 確認点が無い | Intent登録後は、Outcomeの決定からmerge・配置までHumanの確認点が無い | 戻せない操作（本番公開・規則変更）の前だけに確認点を置く |
| 高 | 外部由来の文章を指示と区別しない | Task・コメント・Researchの結果・Humanの返信がAgentのContextに入る。扱いの決まりが`roles/`・`policies/`に無い | 出どころを付けて渡し、指示として扱わない決まりを共通Policyに置く。Researcherの書込みを調査結果だけに絞る |
| 高 | ループの切れ目（製品側） | 製品では、Orchestratorも`ralph/`の`auto`もManagerの受入を起動しない。開発で使うagent-foundation版のRalphは受入まで起動する。Execution Evidenceの還流を行うプロセスはどちらにも無い | agent-foundation版の受入の起動を製品へ取り込み、受入時の還流を追加する |
| 中 | 評価の独立性 | 実装・レビュー・受入・評価を同系統のモデルが行い、EvidenceもAgentが残す | Evidenceを機械の観測（CI・公開記録・計測値）へ寄せる。Evaluatorだけ別のモデルにする。Humanが抜き取りで確認する |
| 中 | 実運転より先に精密化 | 結合テストの起動先はfixture。実AgentによるWorkspace Directionの通し運転は未検証 | 機能追加の前に、1つのIntentを実AgentでEvaluationまで通す |
| 中 | Ralphが2つある | 開発で動くのはagent-foundation版（GitHub連携・検証・復旧あり）。製品の`ralph/`は別実装で、障害史の対処が入っていない | ホスト側でGitを扱うagent-foundation版を土台に一本化する |
| 低 | 文書の読みにくさ・古い記述 | `implementation-status.md`の段落が長い。ADR番号0005・0008が重複。handoffの`pnpm-workspace.yaml`・`infra/`は実在しない | 現況を表へ分け、番号と正本の記述を直す |

## 未確認

- GitHubのブランチ保護の設定（Repositoryの外の設定）。
- MCPへの呼出し回数の制限の有無。
- 発行済みCredentialの期限の運用。

## 進める順番

1. 規則と配置設定を保護パスにし、`main`への直接pushを禁じる。
2. Gitの書込みをホスト側のRalphへ集め、Agentをsandboxへ入れる（Ralphの一本化と同じ作業）。
3. Workspaceの一時停止と費用の上限をServerへ入れる。
4. 受入の起動を製品へ取り込み、還流を追加して、実Agentで1つのIntentをEvaluationまで通す。
5. 対話的開発（InteractiveWorkSession）へ進む。
