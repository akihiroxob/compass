# ADR 0002: 相談（Collaboration）の境界

- 状態: 承認
- 対象: Collaboration / Access / Work / Server

## 背景

Agentが既存の要件・方針・権限では決められない設計・要件の問題をHumanへ問い、非同期の会話と結論をCompassへ残す必要がある。会話・結論・応答の実行権は、Workの作業単位（Task・Claim）、Directionの戦略判断（Direction Decision）、Activityの履歴のいずれとも、言語・ライフサイクル・規則が異なる。

## 決定

- `packages/collaboration`をBounded Contextとして追加し、Consultation・Message・Resolution・応答lease・受付記録を所有する。最初のuse caseはProject scopeの作成・一覧・詳細・返信・結論・取消・応答leaseで、空の構造を先に作らない。
- ConsultationはProject scopeで、所属Workspace IDとProject IDを両方保持する。Workspace scopeの相談は後続で追加する。
- 会話（Message）と結論（Resolution）を分け、どちらも追記とする。訂正は自分の発言を指す新しい発言、解決後の方針変更は元の相談を参照する新しい相談とする。
- 記録主体（Human / Agent）と判断の由来（`human_decision` / `agent_summary`）を区別する。由来は入口と記録主体から決め、入力で指定させない。Humanの明示決定はWeb API専用で、MCPへは公開しない。
- Agentの応答は相談ID・入力版ごとの短い応答leaseと`expectedRevision`・`requestId`で直列化・冪等化する。leaseはTaskのClaimと別のもの。
- 認可はAccessが持つ。HumanはProject Membershipの権限表（参照viewer・返信editor・決定/取消administrator）、AgentはProject Execution Role Grant（参照・作成・返信はmanager / worker / reviewer、結論整理・取消はmanager）で検査する。状態遷移・版・lease・根拠の規則はCollaborationのDomain / Applicationで強制する。
- Collaborationは他Contextのtableを直接読まない。Projectの状態・Resource（Organization）と参照先Task・Story（Work）は、serverが同じtransactionで読むreader portとして渡す。WorkはTaskの相談待ち・再開を所有し、相談の会話・結論を複製しない（相談待ち・再開は後続で接続する）。
- Direction DecisionはIntentに関する戦略判断のまま維持し、相談由来の結論をDirection Decisionとして作らない。Activityへ会話全文を二重保存しない。

## 影響

- serverは`collaboration`のschemaを合成し、Web API（Human）とMCP（Agent）を同じuse caseへ委譲する。Web UIはProject詳細の「判断待ち」viewと相談詳細を持つ。
- Task待機・自動再開・Orchestratorの応答起動・Workspace相談・横断一覧・文書反映Taskはこの決定の範囲外で、[実装計画](../planning/consultation-implementation-plan.md)の後続増分が接続する。
- 現行の契約は[Project相談](../consultation-design.md)に記す。
