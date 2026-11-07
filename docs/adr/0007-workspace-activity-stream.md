# ADR 0007: Workspace横断の業務Activity取得

- 状態: 承認
- 対象: Activity / Work / Server（Web API）/ Web UI

## 決定

Workspaceの権限あるHumanは、Workspace共通と配下の全Project（archivedを含む）の業務Activityを、1つの横断取得（`GET /api/workspaces/:workspaceId/activity-stream`）で読む。Activityの所有・認可は変えない。

- 原記録は既存のProject / Workspace Activity（`activity` table）のまま。横断取得は同じtableを`workspace_id`で引くだけで、複製・別tableを持たない。ProjectのActivityも所属Workspace IDを持つため、漏れ・重複は生じず、別Workspaceとsystem scopeは含まれない。各項目は`id`で`/api/projects/:projectId/activities/:activityId`・`/api/workspaces/:workspaceId/activities/:activityId`の原記録・訂正へ辿れる。
- Agentの入口（MCP）には公開しない。AgentはWorkspace Role Grant / Project Role Grantのscope別一覧のまま使う。
- 認可はWorkspace Membership（viewer以上）。別Workspaceは存在を区別せず404。

## 業務Activityの判定規則

業務Activityは「後から経緯を理解するための意味ある出来事」で、状態変更と同じtransactionで生成するcanonical Activity（`source=canonical`）か、Agentが明示記録した意味的Activity（`source=recorded`）に限る。

| 領域 | Activityにする | Activityにしない（所有元の記録だけ） |
| --- | --- | --- |
| Work（Change Log由来） | Storyの起票・着手・完了・取消、Taskの起票・着手（最初のwork Claim）・作業完了・レビュー承認・受入・差戻し・取消 | Claimの更新・解放・期限切れ・競合、期限切れClaimの引き継ぎ、Reviewer / 受入担当のClaim、Story / Taskの編集 |
| Direction | Intentの作成・放棄、Outcomeの確定・取消・評価、Researchの依頼・終了、Direction Decision | Intent・Outcomeの文言編集、Research結果・Synthesis、ADR・Execution Evidence |
| Organization | Projectのarchive | — |
| Collaboration / Work | — | コメント追加、相談の会話・応答lease（コメント本文の抜粋も載せない） |
| 運用 | — | Operational Log（stdout）、Runtime event、Agent実行観測 |

Change Logは正確な状態変更の追記記録（Claim操作を含む）、Operational Logは運用ログ、Activityは意味のある履歴で、互いを置き換えない。差戻し・取消の理由と受入の根拠はActivityの本文・参照に付随し、詳細はChange Log・原記録を正とする。

## 順序・cursor・検索

- 並びは発生時刻（`occurredAt`）と取得位置（`cursor`）の組。同時刻でも`cursor`で全順序になる。新しい順（`before`）と昇順の差分（`after`）の位置は`{occurredAt}.{cursor}`の不透明な値で、応答の`nextCursor`をそのまま渡す。
- 位置を基準にするため、ページング中の追加・再送（同じ`requestId`は同じActivity）で重複・欠落しない。ただし取得済みの範囲より過去の`occurredAt`で後から追記された記録は、新しい取得（先頭から）で現れる。
- 絞り込みは対象（`projectId` / Workspace共通の`workspaceOnly`）・種別（`type`）・期間（`from` / `to`）・検索（`q`: summary・本文・type・主体の部分一致）。位置を除く条件に一致する件数を`matchedCount`で返す。
- 訂正は追記（`correctsActivityId`）で、原記録を書き換えない。
