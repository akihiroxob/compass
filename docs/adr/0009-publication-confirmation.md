# ADR 0009: 公開確認は開発受入と別の原記録としてWorkが保持する

- 状態: 承認
- 対象: Work / Access / Server

## 背景

Projectのリリース履歴では、何を提供したかを細かく残し、開発の受入・公開・Outcomeの効果を区別して辿る必要がある（[合意UI](../planning/ux-user-scenarios.md)）。Workには受入の記録（`TASK_ACCEPTED`と受入成果物）と、GitHubで確認したPR・merge SHA（[ADR 0004](0004-task-pull-request-verification.md)・[ADR 0005](0005-task-pull-request-transition-verification.md)）がある。しかしPRのmergeやTaskの受入は公開を意味しない。公開はCloudflare・GitHub Actions・手動等の方式で行われ、Compassは公開先を操作しない。公開を知らせる通知は遅れて届き、再送され、ロールバックもある。

## 決定

- 公開確認は、外部のRuntime（CD・デプロイ通知・稼働確認）が送る原記録（`publication_record`）としてWorkが保持する。内容はProjectに登録したRepository・公開先の参照（`target`。例 `production`）・公開先URL・公開されているrevision（完全なcommit SHA）・確認日時（`observedAt`）・方式のラベル（`method`）・根拠の参照（`deployment` / `ci` / `url`のURI。本文は持たない）と、記録した主体・受付時刻とする。追記専用で、同じRepository・公開先・revision・確認日時の再送は同じ記録に収束し、内容が違えば上書きしない。
- デプロイ方式によらず同じ契約（Web API `POST /api/projects/:projectId/publications`・MCP `record_publication`）を使う。方式別の専用管理画面・Entity・必須の「成果」Entityは設けない。入力元はProjectの設定で発行するProject Runtime Credential（scope `publication:write`）とし、Agent Grant・Human Sessionでは記録しない。
- 変更の単位はWorkの既存の記録から導出する。PRを登録したTaskは現在のPRのmerge SHA（受入で照合したSHAを優先）、PRの無い受入済みTaskは受入成果物のCommitを対象Commitとする。Story経由でOutcome、Task・PR・対象Commitへ辿れる。新しい保存Entityを作らない。
- revisionに対象Commitが含まれるかは、Runtimeの申告ではなくRepositoryの履歴（GitHubのcompare）で記録時に判定し、関係（`included` / `not_included`）を記録と一緒に保存する。1件の記録は複数Taskの変更に関係付く。GitHubの読取はtransactionの外で行い、読めなければ何も記録しない（retryable）。Repositoryに無いrevisionは記録しない。GitHub以外のRepositoryは同一SHAだけを含むと判定する。1件の記録で判定する対象Commitは新しい変更から100件までとする。
- 公開状況は公開記録だけから導出し、PRのmerge・Taskの受入から推測しない。公開先（`target`とRepositoryの組）ごとに、確認日時の最も新しい記録（同時刻は受付順）で判定する。
  - `published`: 最新の記録のrevisionに対象Commitがすべて含まれる。公開日時は、すべて含んだ最初の記録の確認日時。
  - `not_published`: 最新の記録のrevisionに含まれない対象Commitがある（未公開。ロールバックを含む）。
  - `unconfirmed`（確認できず）: 入力元の設定も記録もない（`not_configured`）、対象Commitが無い（未merge等、`no_revision`）、対象Repositoryの記録が無い（`no_record`）、最新の記録で判定していない（記録後にmergeが判明した等、`not_compared`）。
- 古い確認日時の通知は原記録として残すが、現在の状況を戻さない（応答の`superseded: true`）。変更全体の状況は、いずれかの公開先で公開済みなら`published`、そうでなく未公開を確認した公開先があれば`not_published`、それ以外は確認できずとし、公開先ごとの詳細を併せて返す。
- 開発の受入（`development`）と公開（`publication`）は別の項目で返す。公開済みは利用者・事業への効果の確認（Outcomeの評価）を意味しない。
- 公開記録はChange Log・canonical Activityへ投影しない。リリース履歴自体が原記録への導線になる。

## 影響

- Human向けにリリース履歴の取得（Web API `GET /api/projects/:projectId/releases`、所属WorkspaceのMembership）を提供する。Web UIのリリース履歴への接続は別Taskで同じ応答を使う。
- 確認日時の新旧で現在を決めるため、時刻の大きく狂った入力元は誤った現在を作り得る。未来の確認日時は拒否する。
- 現行の契約は[実装状況](../implementation-status.md#公開確認とリリース履歴の現行契約)、Runtimeの手順は`roles/runtime.md`に記す。
