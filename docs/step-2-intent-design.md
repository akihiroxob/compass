# Intentの現行仕様

IntentはHumanが現在実現したい状態。Workspaceの継続的な存在理由であるMissionと区別する。型は [Intent.ts](../packages/direction/src/domain/Intent.ts)、入力規則は [intentSchema.ts](../packages/direction/src/application/intentSchema.ts)。

## 項目と状態

`workspaceId`、必須の`title`（100文字まで）・`desiredState`（2,000文字まで）、任意の`completionDefinition`（2,000文字まで）、`status`、`abandonedReason`、ID・作成更新日時を持つ。

状態は`active` / `achieved` / `abandoned`。Workspace内のActive Intentは最大1件で、DBの部分一意indexでも強制する。作成時はactive。Humanの放棄はabandonedへ遷移する。Strategistの根拠付き`intent_complete`判断でachievedへ遷移する。終端からの復帰操作はない。

## 更新と操作

activeの間だけ部分更新できる。Outcomeを持つIntentはtitleのみ変更でき、desiredState / completionDefinitionを変更できない。archived Workspaceでは書込を拒否する（WorkspaceのarchiveはWorkspace ownerが行い、Projectのarchiveでは変わらない）。

`intent_complete`も、Intentを更新するtransaction内で所属Workspaceのarchiveを検査する。WorkspaceだけarchivedでProjectがactiveでも`CONFLICT`（`workspaceStatus: archived`）を返し、Intent・Decision・Activityを変更しない。

保存・application use case・公開入口はWorkspace単位。Project IDをWorkspace IDとして受け付けない。応答は`workspaceId`を持ち、`projectId`は持たない。

HumanはProject詳細から作成し、Intent詳細から編集・放棄する（画面はProjectの所属Workspaceを解決する）。Web APIは`/api/workspaces/:workspaceId/intents`とその詳細・更新・`abandon`。参照にはWorkspaceのviewer以上、変更にはeditor以上のWorkspace Membershipが必要で、Project Membershipからは継承しない。MCPの`create_intent` / `update_intent` / `abandon_intent`（trusted-localだけ）は`workspaceId`を受け取り、WorkspaceのDirection Role Grantを持つPrincipalとactiveRole指定を拒否する。remote modeのMCPにはHuman用の作成・更新・放棄toolを公開しない。

## Researchとの接続

Intent作成はResearch Requestを作らない。OrchestratorがActive IntentでStrategistを起動し、StrategistがResearchの必要性を判断する（必要なら`additional_research`のDirection Decisionで依頼する）。起動条件は [Orchestrator](../orchestrator/README.md)。
